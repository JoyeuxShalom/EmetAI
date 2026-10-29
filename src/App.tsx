// EmetAI root — routes + guards.
//   #/            landing (public)
//   #/login       sign in
//   #/register    create account
//   #/app         live service studio   (login + active subscription)
//   #/clips       sermon clips studio   (login + active subscription)
//   #/learning    what Emet has learned; review a service (login)
//   #/account     subscription & password (login)
//   #/admin       admin dashboard       (admin only)
//   #display      projector window (opened by the studio, no login UI)

import Shell from "./components/Shell"
import { useAuth } from "./lib/auth"
import { useRoute } from "./lib/router"
import Account from "./pages/Account"
import Admin from "./pages/Admin"
import Auth from "./pages/Auth"
import Clips from "./pages/Clips"
import Display from "./pages/Display"
import Landing from "./pages/Landing"
import Learning from "./pages/Learning"
import Studio from "./pages/Studio"

function Loading() {
  return (
    <main className="flex h-full items-center justify-center bg-ink">
      <p className="animate-pulse-soft font-sans text-sm uppercase tracking-[0.3em] text-parchment-dim/60">
        EmetAI
      </p>
    </main>
  )
}

function Locked() {
  return (
    <main className="flex h-full items-center justify-center bg-ink-soft p-8 text-center">
      <div className="max-w-md">
        <p className="font-display text-2xl text-gold">This area is for administrators</p>
        <p className="mt-3 font-sans text-sm text-parchment-dim">
          Your account doesn't have access to this page. The Studio and your account
          settings are always open to you.
        </p>
        <a
          href="#/app"
          className="mt-6 inline-block rounded-lg bg-gold px-6 py-2.5 font-sans text-sm font-medium text-ink transition hover:bg-gold-deep"
        >
          Open the Studio →
        </a>
      </div>
    </main>
  )
}

export default function App() {
  const route = useRoute()
  const { user, loading } = useAuth()

  // The projector window — must render instantly, no auth roundtrip.
  if (route === "#display") return <Display />

  if (loading) return <Loading />

  // Public routes
  if (route === "" || route === "#" || route === "#/") return <Landing />
  if (route.startsWith("#/login")) return user ? redirect("#/app") : <Auth key="login" mode="login" />
  if (route.startsWith("#/register")) return user ? redirect("#/app") : <Auth key="register" mode="register" />

  // Everything below needs a signed-in user.
  if (!user) return redirect("#/login")

  if (route.startsWith("#/admin")) {
    const staff = user.role === "admin" || user.role === "assistant"
    return <Shell>{staff ? <Admin /> : <Locked />}</Shell>
  }
  if (route.startsWith("#/account")) return <Shell><Account /></Shell>

  // The Studio is never locked: manual scripture display is free for ever.
  // Paid features are gated inside it, where the upgrade is one click away.
  if (route.startsWith("#/app")) return <Shell><Studio /></Shell>
  if (route.startsWith("#/clips")) return <Shell><Clips /></Shell>
  if (route.startsWith("#/learning")) return <Shell><Learning /></Shell>

  return <Landing />
}

function redirect(to: string) {
  window.location.hash = to
  return <Loading />
}
