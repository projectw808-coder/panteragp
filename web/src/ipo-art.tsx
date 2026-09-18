/**
 * A drawn mark for each offering, for the card to wear when no picture has been uploaded.
 *
 * The same decision as asset-art: line work rather than logos. A company's real mark is its
 * trademark and this is a simulated desk, so borrowing one would be both a legal question
 * and a claim of affiliation nobody here is entitled to make. These are abstractions of what
 * the company does — an orbit, a rack, a wafer — which read at card size and belong to us.
 *
 * Inline SVG rather than files: there are eight of them, they are a few hundred bytes each,
 * and they inherit `currentColor` so the ember tint and both themes come for free. A file
 * would be a network round trip and a thing that can 404.
 *
 * Keyed by the offering's asset code, because that is what the desk types when it creates
 * one. Anything unrecognised gets the fallback, which is why a new offering is never blank.
 */

type MarkProps = { className?: string };

const frame = (children: React.ReactNode, tint?: string) => (
  <svg viewBox="0 0 320 180" fill="none" stroke="currentColor" strokeWidth="1.4"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden
    style={tint ? { color: tint } : undefined}>
    {children}
    {/* A ground line under every mark, so eight different drawings still look like a set. */}
    <path d="M0 162h320" opacity=".4" />
  </svg>
);

/**
 * A colour per offering, so eight cards are told apart at a glance.
 *
 * This is the part of a logo that actually does the work in a list: long before anybody
 * reads a name, they have found the card by its colour. A hue is not a trademark and this is
 * not anybody's mark — the drawing it colours is ours, and nothing here reproduces a logo,
 * claims a relationship with the company, or would pass for its branding.
 *
 * It is the one place in this app where colour outside the ember scale is allowed. The rule
 * it bends — ember is the only chromatic colour — exists so that colour carries meaning
 * rather than decoration, and here it does: it identifies which offering you are looking at.
 * It stays inside the artwork frame and never reaches a figure, a status or a control.
 */
const TINTS: Record<string, string> = {
  ANTH: '#d97757',   // clay
  NSCL: '#3d7de0',   // a cold blue, for racks in Narvik
  OAI:  '#0f9d76',   // green
  DBX:  '#e04a2f',   // red
  SPCX: '#7c8794',   // steel, and the only near-neutral of the set
  CRNE: '#2e9e5b',   // wind and solar
  SKHY: '#d8452f',   // memory red
  CBRS: '#7c5cd6',   // wafer violet
};

/** The colour an offering is identified by, or the house ember when it has none. */
export const markTint = (asset: string) => TINTS[asset?.toUpperCase()] ?? null;

const MARKS: Record<string, React.ReactNode> = {
  // Anthropic — concentric rings, the widening circle of a model's reach.
  ANTH: (<>
    <circle cx="160" cy="90" r="34" />
    <circle cx="160" cy="90" r="56" opacity=".5" />
  </>),

  // Nscale — three racks in a row, which is what a GPU data centre is.
  NSCL: (<>
    <rect x="52" y="60" width="60" height="60" />
    <rect x="130" y="60" width="60" height="60" opacity=".7" />
    <rect x="208" y="60" width="60" height="60" opacity=".45" />
    <path d="M66 76h32M66 88h32M144 76h32M144 88h32M222 76h32M222 88h32" opacity=".5" />
  </>),

  // OpenAI — a faceted diamond, cut on an axis.
  OAI: (<>
    <path d="M160 34 118 90l42 56 42-56-42-56Z" />
    <path d="M96 90h128" opacity=".45" />
    <path d="M118 90h84" opacity=".3" />
  </>),

  // Databricks — a stack of cylinders, the oldest drawing of a database there is.
  DBX: (<>
    <ellipse cx="160" cy="62" rx="62" ry="18" />
    <path d="M98 62v34c0 10 28 18 62 18s62-8 62-18V62" />
    <path d="M98 96v26c0 10 28 18 62 18s62-8 62-18V96" opacity=".6" />
  </>),

  // SpaceX — an ascent line and the arc it is leaving.
  SPCX: (<>
    <path d="M40 146C96 146 176 112 232 44" />
    <path d="M232 44l-34 6M232 44l-6 34" />
    <circle cx="160" cy="90" r="52" opacity=".35" />
  </>),

  // China Resources New Energy — a turbine and the sun behind it.
  CRNE: (<>
    <circle cx="160" cy="88" r="10" />
    <path d="M160 78V40M160 96l-34 20M160 96l34 20" />
    <circle cx="160" cy="88" r="54" opacity=".35" />
  </>),

  // SK hynix — stacked memory dies, which is what HBM is.
  SKHY: (<>
    <rect x="96" y="104" width="128" height="20" />
    <rect x="96" y="80" width="128" height="20" opacity=".7" />
    <rect x="96" y="56" width="128" height="20" opacity=".45" />
    <path d="M118 56v-14M160 56v-14M202 56v-14" opacity=".5" />
  </>),

  // Cerebras — one wafer, scored into the grid it is cut from.
  CBRS: (<>
    <circle cx="160" cy="90" r="50" />
    <path d="M128 48v84M160 40v100M192 48v84" opacity=".5" />
    <path d="M114 68h92M110 90h100M114 112h92" opacity=".5" />
  </>),
};

/**
 * The fallback: a listing's price steps. Deliberately generic, because it stands in for an
 * offering nobody has drawn yet and should look considered rather than missing.
 */
const FALLBACK = (<>
  <path d="M60 130V98M104 130V74M148 130V86M192 130V58M236 130V78" />
  <path d="M60 98l44-24 44 12 44-28 44 20" opacity=".5" />
</>);

export function IpoMark({ asset }: { asset: string } & MarkProps) {
  const key = asset?.toUpperCase();
  return frame(MARKS[key] ?? FALLBACK, TINTS[key]);
}

/** Whether this offering has a drawn mark of its own, as opposed to the generic one. */
export const hasMark = (asset: string) => !!MARKS[asset?.toUpperCase()];
