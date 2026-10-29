# Creating EmetAI's server on Oracle Cloud, idempotently.
#
# Two jobs, and they fail in completely different ways:
#
#   Networking always succeeds. There is no scarcity in a virtual network, so
#   it is created once and reused. Run this script ten times and you still
#   have one VCN.
#
#   The instance frequently does NOT succeed. Oracle's free ARM capacity in a
#   single-availability-domain region like Johannesburg is genuinely scarce,
#   and "Out of host capacity" is the normal answer, not an error in the
#   request. So launching retries on a loop rather than giving up — which is
#   the whole reason this is a script and not a wizard.
#
# Usage:
#   python deploy/provision.py network        create/verify the network only
#   python deploy/provision.py launch         try once
#   python deploy/provision.py retry [hours]  keep trying until capacity appears
#   python deploy/provision.py status         what exists right now

import sys
import time

import oci

NAME = "emetai"
VCN_CIDR = "10.0.0.0/16"
SUBNET_CIDR = "10.0.0.0/24"
SHAPE = "VM.Standard.A1.Flex"
OCPUS = 1          # a smaller ask is far likelier to find capacity than 4
MEMORY_GB = 6
IMAGE_OS = "Canonical Ubuntu"
IMAGE_VERSION = "22.04"
# The ports a church needs open: SSH for me, HTTP/HTTPS for the Studio. 80 is
# needed as well as 443 because Let's Encrypt validates over it.
OPEN_PORTS = [22, 80, 443]
# Oracle rate-limits launch attempts hard. Retrying every two minutes earned
# a 429 after the second try, which is worse than waiting: a throttled account
# cannot launch even when capacity appears. Five minutes between attempts, and
# a long sit-down if it throttles us anyway.
RETRY_SECONDS = 300
THROTTLED_SECONDS = 900

cfg = oci.config.from_file()
TENANCY = cfg["tenancy"]
core = oci.core.ComputeClient(cfg)
net = oci.core.VirtualNetworkClient(cfg)
ident = oci.identity.IdentityClient(cfg)


def find(items, name):
    for item in items:
        if item.display_name == name and item.lifecycle_state not in (
            "TERMINATED", "TERMINATING"
        ):
            return item
    return None


def wait_available(get, what):
    for _ in range(60):
        item = get()
        if item.lifecycle_state == "AVAILABLE":
            return item
        time.sleep(2)
    raise RuntimeError(f"{what} never became available")


# ---------------------------------------------------------------- network ---
def ensure_network():
    vcn = find(net.list_vcns(compartment_id=TENANCY).data, NAME)
    if not vcn:
        print("  creating the virtual network...")
        vcn = net.create_vcn(oci.core.models.CreateVcnDetails(
            compartment_id=TENANCY, cidr_block=VCN_CIDR, display_name=NAME,
            dns_label=NAME,
        )).data
        vcn = wait_available(lambda: net.get_vcn(vcn.id).data, "VCN")
    print(f"  network      {vcn.display_name} {vcn.cidr_block}")

    gw = find(net.list_internet_gateways(compartment_id=TENANCY, vcn_id=vcn.id).data, NAME)
    if not gw:
        print("  creating the internet gateway...")
        gw = net.create_internet_gateway(oci.core.models.CreateInternetGatewayDetails(
            compartment_id=TENANCY, vcn_id=vcn.id, is_enabled=True, display_name=NAME,
        )).data
    print(f"  gateway      {gw.display_name}")

    # Route everything not local out through the gateway, or the instance can
    # reach nothing and nothing can reach it.
    rt = net.get_route_table(vcn.default_route_table_id).data
    if not any(r.network_entity_id == gw.id for r in rt.route_rules):
        print("  routing traffic through the gateway...")
        net.update_route_table(rt.id, oci.core.models.UpdateRouteTableDetails(
            route_rules=[oci.core.models.RouteRule(
                destination="0.0.0.0/0", destination_type="CIDR_BLOCK",
                network_entity_id=gw.id, description="internet",
            )]))

    # Oracle's default security list allows SSH only. A web server behind it
    # looks like it is running and answers nothing - the classic trap.
    sl = net.get_security_list(vcn.default_security_list_id).data
    have = {r.tcp_options.destination_port_range.min
            for r in sl.ingress_security_rules
            if r.tcp_options and r.tcp_options.destination_port_range}
    if not set(OPEN_PORTS).issubset(have):
        print(f"  opening ports {OPEN_PORTS}...")
        rules = [oci.core.models.IngressSecurityRule(
            protocol="6", source="0.0.0.0/0", is_stateless=False,
            tcp_options=oci.core.models.TcpOptions(
                destination_port_range=oci.core.models.PortRange(min=p, max=p)),
            description=f"port {p}",
        ) for p in OPEN_PORTS]
        net.update_security_list(sl.id, oci.core.models.UpdateSecurityListDetails(
            ingress_security_rules=rules,
            egress_security_rules=sl.egress_security_rules))
    print(f"  firewall     ports {OPEN_PORTS} open")

    subnet = find(net.list_subnets(compartment_id=TENANCY, vcn_id=vcn.id).data, NAME)
    if not subnet:
        print("  creating the public subnet...")
        subnet = net.create_subnet(oci.core.models.CreateSubnetDetails(
            compartment_id=TENANCY, vcn_id=vcn.id, cidr_block=SUBNET_CIDR,
            display_name=NAME, dns_label=NAME, prohibit_public_ip_on_vnic=False,
        )).data
        subnet = wait_available(lambda: net.get_subnet(subnet.id).data, "subnet")
    print(f"  subnet       {subnet.display_name} (public)")
    return subnet


def newest_image():
    images = core.list_images(
        compartment_id=TENANCY, operating_system=IMAGE_OS,
        operating_system_version=IMAGE_VERSION, shape=SHAPE,
        sort_by="TIMECREATED", sort_order="DESC",
    ).data
    if not images:
        raise RuntimeError("no Ubuntu image found for this shape")
    return images[0]


# --------------------------------------------------------------- instance ---
def existing_instance():
    return find(core.list_instances(compartment_id=TENANCY).data, NAME)


def public_ip(instance):
    for vnic_att in core.list_vnic_attachments(
        compartment_id=TENANCY, instance_id=instance.id
    ).data:
        if vnic_att.lifecycle_state != "ATTACHED":
            continue
        vnic = net.get_vnic(vnic_att.vnic_id).data
        if vnic.public_ip:
            return vnic.public_ip
    return None


def launch(subnet, ssh_public_key):
    image = newest_image()
    ad = ident.list_availability_domains(compartment_id=TENANCY).data[0].name
    details = oci.core.models.LaunchInstanceDetails(
        compartment_id=TENANCY,
        availability_domain=ad,
        display_name=NAME,
        shape=SHAPE,
        shape_config=oci.core.models.LaunchInstanceShapeConfigDetails(
            ocpus=OCPUS, memory_in_gbs=MEMORY_GB),
        source_details=oci.core.models.InstanceSourceViaImageDetails(
            image_id=image.id, boot_volume_size_in_gbs=50),
        create_vnic_details=oci.core.models.CreateVnicDetails(
            subnet_id=subnet.id, assign_public_ip=True),
        metadata={"ssh_authorized_keys": ssh_public_key},
    )
    return core.launch_instance(details).data


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    key_path = __import__("os").path.expanduser("~/.ssh/emetai_oracle.pub")
    ssh_key = open(key_path).read().strip()

    if action == "status":
        inst = existing_instance()
        if not inst:
            print("No EmetAI instance yet.")
            return
        print(f"{inst.display_name}: {inst.lifecycle_state}  {inst.shape}")
        ip = public_ip(inst)
        print(f"public IP: {ip or '(not assigned yet)'}")
        return

    print("Network")
    subnet = ensure_network()
    if action == "network":
        return

    inst = existing_instance()
    if inst:
        print(f"\nAn instance already exists: {inst.lifecycle_state}")
        print(f"public IP: {public_ip(inst) or '(pending)'}")
        return

    hours = float(sys.argv[2]) if len(sys.argv) > 2 else 0
    deadline = time.time() + hours * 3600
    attempt = 0
    print(f"\nLaunching {SHAPE} {OCPUS} OCPU / {MEMORY_GB} GB")
    while True:
        attempt += 1
        try:
            inst = launch(subnet, ssh_key)
            print(f"\n  [{attempt}] LAUNCHED - {inst.id[-12:]}")
            break
        except oci.exceptions.ServiceError as e:
            message = (e.message or "")
            stamp = time.strftime("%H:%M:%S")
            print(f"  [{attempt}] {stamp} {message[:70]}", flush=True)
            if e.status == 429:
                wait = THROTTLED_SECONDS      # throttled: stop pushing
            elif "capacity" in message.lower():
                wait = RETRY_SECONDS          # normal: the pool is just full
            else:
                raise                         # a real problem with the request
            if time.time() >= deadline:
                print("  giving up for now - run this again later", flush=True)
                return
            time.sleep(wait)
        except Exception as e:
            # A dropped connection must not end a twelve-hour watch.
            print(f"  [{attempt}] {type(e).__name__}: {str(e)[:60]}", flush=True)
            if time.time() >= deadline:
                return
            time.sleep(RETRY_SECONDS)

    print("  waiting for it to boot...")
    inst = wait_available(lambda: core.get_instance(inst.id).data, "instance")
    for _ in range(30):
        ip = public_ip(inst)
        if ip:
            print(f"\n  RUNNING at {ip}")
            print(f"  ssh -i ~/.ssh/emetai_oracle ubuntu@{ip}")
            return
        time.sleep(4)
    print("  running, but no public IP yet - check status in a moment")


main()
