// A slowly turning cylinder of scripture, stood on its edge beside the hero.
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
// The ring is centred behind the headline now, so it has to be wide enough
// that the readable scrolls pass well clear of the text rather than behind
// it: the headline column is 768px, and at this radius the scrolls sit about
// 460px either side of centre, outside it on both flanks.
const RADIUS = 640

export default function ScrollRing() {
  return (
    <div className="scroll-ring-stage" aria-hidden="true">
      <div className="scroll-ring">
        {SCROLLS.map((s, i) => (
          <article
            key={s.ref}
            className="scroll-ring-panel"
            style={{ transform: `rotateY(${i * STEP}deg) translateZ(${RADIUS}px)` }}
          >
            <span className="scroll-ring-tongue">{s.tongue}</span>
            <span className="scroll-ring-ref">{s.ref}</span>
            <span className="scroll-ring-line">{s.line}</span>
          </article>
        ))}
      </div>
    </div>
  )
}
