// A slowly turning ring of scripture, tilted so the hero sits inside it.
//
// It is decoration with a job. What EmetAI does is hear one sentence and find
// it in three Bibles at once, and that is hard to photograph. A ring of real
// verses — Kinyarwanda, English and French, the same passage turning past in
// all three — says it before a word of copy is read.
//
// Real references, real wording. A ring of lorem-ipsum rectangles would read
// as a stock graphic, which is the one thing this page cannot afford.
//
// Built from CSS 3D transforms rather than canvas or a library: it is one
// animated property on a parent element, the GPU does the work, and it costs
// the hall's internet nothing. The Studio has to run on poor connections and
// the page that advertises it should embarrass itself less, not more.
//
// ── Why every scroll is rendered twice ──────────────────────────────────
// The ring is tilted towards the reader, so you look down INTO it: the near
// wall you see from outside, the far wall you see from inside. A panel has
// one printed face, and the back of it paints every word mirrored — which is
// exactly the fault that showed "Philippians 4:13" reversed in the hero.
//
// Hiding backfaces fixes the mirroring but then half the ring vanishes and
// the ellipse breaks into an arc. So each scroll is placed twice at the same
// point in space, once facing out and once facing in:
//
//     out   rotateY(θ)        translateZ( R)     normal points away from axis
//     in    rotateY(θ + 180°) translateZ(−R)     same point, normal reversed
//
// Both land on (R·sinθ, 0, R·cosθ). With backfaces hidden, exactly one of
// each pair is ever drawn — the outward one while the scroll is on the near
// side, the inward one while it is on the far side. The ring is whole, and
// every word reads the right way round from wherever you catch it.

type Scroll = { ref: string; line: string; tongue: string }

// Three passages a Rwandan congregation knows, each in the three tongues the
// ear hears. Ordered so the languages interleave as the ring turns.
const SCROLLS: Scroll[] = [
  { ref: "Yohana 3:16", line: "Imana yakunze abari mu isi cyane", tongue: "RW" },
  { ref: "John 3:16", line: "For God so loved the world", tongue: "EN" },
  { ref: "Jean 3:16", line: "Car Dieu a tant aimé le monde", tongue: "FR" },
  { ref: "Zaburi 23:1", line: "Uwiteka ni umwungeri wanjye", tongue: "RW" },
  { ref: "Psalm 23:1", line: "The LORD is my shepherd", tongue: "EN" },
  { ref: "Psaume 23:1", line: "L’Éternel est mon berger", tongue: "FR" },
  { ref: "Matayo 11:28", line: "Nimuze kuri jye mwese abarushye", tongue: "RW" },
  { ref: "Matthew 11:28", line: "Come unto me, all ye that labour", tongue: "EN" },
  { ref: "Matthieu 11:28", line: "Venez à moi, vous tous qui peinez", tongue: "FR" },
  { ref: "Abafilipi 4:13", line: "Nshobozwa byose na Kristo", tongue: "RW" },
  { ref: "Philippians 4:13", line: "I can do all things through Christ", tongue: "EN" },
  { ref: "Philippiens 4:13", line: "Je puis tout par celui qui me fortifie", tongue: "FR" },
  { ref: "Yesaya 40:31", line: "Bazaguruka n’amababa nk’aya kagoma", tongue: "RW" },
  { ref: "Isaiah 40:31", line: "They shall mount up with wings as eagles", tongue: "EN" },
  { ref: "Ésaïe 40:31", line: "Ils prennent leur vol comme les aigles", tongue: "FR" },
]

const STEP = 360 / SCROLLS.length

// The radius lives in CSS, as --ring-radius, because it is the one thing that
// has to change with the width of the screen and the breakpoint belongs with
// the rest of the layout. On a desktop the ring is wide enough that the
// scrolls pass either side of a 768px headline; on a phone there is no such
// room, so it shrinks to a halo behind the words instead.

function Scroll({ scroll, transform }: { scroll: Scroll; transform: string }) {
  return (
    <article className="scroll-ring-panel" style={{ transform }}>
      <span className="scroll-ring-tongue">{scroll.tongue}</span>
      <span className="scroll-ring-ref">{scroll.ref}</span>
      <span className="scroll-ring-line">{scroll.line}</span>
    </article>
  )
}

export default function ScrollRing() {
  return (
    <div className="scroll-ring-stage" aria-hidden="true">
      <div className="scroll-ring">
        {SCROLLS.map((s, i) => {
          const angle = i * STEP
          return [
            <Scroll
              key={`${s.ref}-out`}
              scroll={s}
              transform={`rotateY(${angle}deg) translateZ(var(--ring-radius))`}
            />,
            <Scroll
              key={`${s.ref}-in`}
              scroll={s}
              transform={
                `rotateY(${angle + 180}deg) ` +
                `translateZ(calc(-1 * var(--ring-radius)))`
              }
            />,
          ]
        })}
      </div>
    </div>
  )
}
