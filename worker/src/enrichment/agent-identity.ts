/**
 * Generate culturally-appropriate agent names and avatars based on the
 * founder's nationality. Uses Gemini for name generation and Gemini 3.1 Flash
 * Image (via OpenRouter first) for realistic profile pictures.
 */

import type { Env, FoundingRole } from "../types.js";

export interface AgentIdentity {
  name: string;       // Full realistic name (e.g. "Marco Bianchi")
  avatarUrl: string;  // R2/KV URL to the generated avatar image, or empty string
}

interface GeneratedNames {
  ceo: string;
  cto: string;
  engineer1: string;
  engineer2: string;
  qa_lead: string;
  api_key_agent: string;
  cmo: string;
}

interface SingleGeneratedName {
  name: string;
}

interface AvatarVariant {
  framing: string;
  setting: string;
  styling: string;
  vibe: string;
}

type AvatarPoolRoleClass = "executive" | "specialist";

interface AvatarPoolSlotSpec {
  id: string;
  roleClass: AvatarPoolRoleClass;
  presentation: "feminine" | "masculine";
  sex: "man" | "woman";
  skinTone: "light" | "medium" | "deep";
  ageBand: string;
  ethnicity: string;
  hair: string;
  clothing: string;
  expression: string;
  framing: string;
  background: string;
  lighting: string;
  camera: string;
  accessory: string;
}

interface AvatarPoolSlotState {
  slotId: string;
  roleClass: AvatarPoolRoleClass;
  tags: string[];
  status: "ready" | "warming";
  lastGeneratedAt: string | null;
  lastClaimedAt: string | null;
  generationCount: number;
  contentType: string;
}

interface FounderCountryContext {
  country: string;
  countryName: string;
}

const FOUNDING_NAME_POOLS_BY_COUNTRY: Record<string, GeneratedNames[]> = {
  IT: [
    { ceo: "Filippo Donati", cto: "Camilla Sartori", engineer1: "Ludovica Piras", engineer2: "Valerio Rinaldi", qa_lead: "Ilaria Farina", api_key_agent: "Jacopo Valenti", cmo: "Costanza Marini" },
    { ceo: "Edoardo Cattaneo", cto: "Giulia Ferrante", engineer1: "Tommaso Sanna", engineer2: "Noemi Gentili", qa_lead: "Davide Marchetti", api_key_agent: "Elena Galli", cmo: "Alessandro Rossetti" },
    { ceo: "Beatrice Pellegrini", cto: "Riccardo Palmieri", engineer1: "Chiara Monti", engineer2: "Lorenzo Bellini", qa_lead: "Ginevra Colombo", api_key_agent: "Andrea Barbieri", cmo: "Matilde Caruso" },
    { ceo: "Niccolò Esposito", cto: "Sara Lombardi", engineer1: "Federico Zanetti", engineer2: "Francesca Morandi", qa_lead: "Simone Basile", api_key_agent: "Valentina Sorrentino", cmo: "Giacomo Mazza" },
    { ceo: "Veronica Albanese", cto: "Luca Ferretti", engineer1: "Arianna Gallo", engineer2: "Matteo Marchesi", qa_lead: "Serena Vitali", api_key_agent: "Pietro Amato", cmo: "Aurora Silvestri" },
    { ceo: "Marco Benedetti", cto: "Roberta Parisi", engineer1: "Emanuele Fontana", engineer2: "Caterina Morelli", qa_lead: "Alberto Greco", api_key_agent: "Marta Battaglia", cmo: "Leonardo Ferrara" },
  ],
  DEFAULT: [
    { ceo: "Avery Morales", cto: "Nina Park", engineer1: "Julian Cross", engineer2: "Maya Bennett", qa_lead: "Leah Dawson", api_key_agent: "Owen Patel", cmo: "Sofia Reed" },
    { ceo: "Marcus Chen", cto: "Elena Vasquez", engineer1: "Priya Sharma", engineer2: "Caleb Okonkwo", qa_lead: "Tessa Novak", api_key_agent: "Amir Haddad", cmo: "Rachel Nguyen" },
    { ceo: "Jordan Blackwell", cto: "Mira Okafor", engineer1: "Soren Lindberg", engineer2: "Anika Patel", qa_lead: "Damon Cruz", api_key_agent: "Layla Abrams", cmo: "Felix Moreau" },
    { ceo: "Sienna Cole", cto: "Kai Tanaka", engineer1: "Rowan Mercer", engineer2: "Zara Ashford", qa_lead: "Elliot Chen", api_key_agent: "Nadia Kowalski", cmo: "Jasper Dominguez" },
    { ceo: "Derek Yamamoto", cto: "Samara Wells", engineer1: "Lucien Dubois", engineer2: "Preet Kaur", qa_lead: "Cameron Reyes", api_key_agent: "Thea Sandoval", cmo: "Mateo Ivanov" },
    { ceo: "Blair Hamilton", cto: "Ansel Rivera", engineer1: "Kira Johansson", engineer2: "Tariq Bassam", qa_lead: "Maren Wolfe", api_key_agent: "Declan Torres", cmo: "Ines Castellano" },
  ],
  DE: [
    { ceo: "Maximilian Bauer", cto: "Lena Schreiber", engineer1: "Tobias Hartmann", engineer2: "Maren Vogt", qa_lead: "Fabian Kessler", api_key_agent: "Clara Engel", cmo: "Niklas Brandt" },
    { ceo: "Hannah Richter", cto: "Florian Meier", engineer1: "Johanna Bergmann", engineer2: "Lukas Zimmermann", qa_lead: "Amelie Wirth", api_key_agent: "Sebastian Kling", cmo: "Antonia Pfeifer" },
  ],
  FR: [
    { ceo: "Théo Fontaine", cto: "Manon Deschamps", engineer1: "Léa Garnier", engineer2: "Hugo Marchand", qa_lead: "Clémence Petit", api_key_agent: "Raphaël Leroy", cmo: "Inès Blanchard" },
    { ceo: "Camille Rousseau", cto: "Bastien Lemaire", engineer1: "Juliette Morel", engineer2: "Antoine Vasseur", qa_lead: "Margaux Perrin", api_key_agent: "Adrien Chevalier", cmo: "Mathilde Fabre" },
  ],
  ES: [
    { ceo: "Pablo Herrera", cto: "Lucía Navarro", engineer1: "Adrián Molina", engineer2: "Carmen Delgado", qa_lead: "Álvaro Ramos", api_key_agent: "Elena Vega", cmo: "Marcos Salazar" },
    { ceo: "Sofía Castillo", cto: "Diego Mendoza", engineer1: "Valentina Reyes", engineer2: "Andrés Paredes", qa_lead: "Clara Ibáñez", api_key_agent: "Mateo Fuentes", cmo: "Irene Aguilar" },
  ],
  BR: [
    { ceo: "Gustavo Ferreira", cto: "Mariana Almeida", engineer1: "Caio Ribeiro", engineer2: "Larissa Cardoso", qa_lead: "Henrique Barros", api_key_agent: "Isadora Monteiro", cmo: "Rafael Teixeira" },
    { ceo: "Beatriz Nascimento", cto: "Thiago Correia", engineer1: "Fernanda Duarte", engineer2: "Lucas Pinheiro", qa_lead: "Amanda Bastos", api_key_agent: "Matheus Cavalcanti", cmo: "Camila Araújo" },
  ],
  JP: [
    { ceo: "Yuki Tanaka", cto: "Haruto Nakamura", engineer1: "Sakura Watanabe", engineer2: "Ren Yamamoto", qa_lead: "Aoi Ishikawa", api_key_agent: "Sora Matsuda", cmo: "Hina Suzuki" },
    { ceo: "Takumi Kobayashi", cto: "Mio Ito", engineer1: "Kaito Saito", engineer2: "Riko Kimura", qa_lead: "Yuto Hayashi", api_key_agent: "Akari Mori", cmo: "Sota Shimizu" },
  ],
  IN: [
    { ceo: "Arjun Mehta", cto: "Priya Iyer", engineer1: "Karan Deshmukh", engineer2: "Ananya Reddy", qa_lead: "Vikram Bhatia", api_key_agent: "Sneha Kulkarni", cmo: "Rohan Joshi" },
    { ceo: "Meera Kapoor", cto: "Aditya Nair", engineer1: "Kavya Subramaniam", engineer2: "Siddharth Rao", qa_lead: "Ishaan Chandra", api_key_agent: "Tanvi Malhotra", cmo: "Nikhil Verma" },
  ],
  KR: [
    { ceo: "Minjun Park", cto: "Soyeon Kim", engineer1: "Jiho Lee", engineer2: "Yuna Choi", qa_lead: "Hyunwoo Jang", api_key_agent: "Dahye Shin", cmo: "Seojin Han" },
  ],
  GB: [
    { ceo: "Oliver Whitfield", cto: "Amara Osei", engineer1: "Callum Fraser", engineer2: "Freya Hartley", qa_lead: "Reuben Kaur", api_key_agent: "Isla Brennan", cmo: "Thomas Adebayo" },
    { ceo: "Sophie Carmichael", cto: "Idris Okoro", engineer1: "Ewan Gallagher", engineer2: "Niamh Sinclair", qa_lead: "Aiden Mahmood", api_key_agent: "Phoebe Lennox", cmo: "Raj Krishnamurthy" },
  ],
};

function pickRandomNameSet(pool: GeneratedNames[]): GeneratedNames {
  return pool[Math.floor(Math.random() * pool.length)];
}

const DEFAULT_FOUNDING_NAMES_BY_COUNTRY: Record<string, GeneratedNames> = Object.fromEntries(
  Object.entries(FOUNDING_NAME_POOLS_BY_COUNTRY).map(([k, v]) => [k, v[0]]),
);

const SPECIALIST_NAME_POOLS_BY_COUNTRY: Record<string, Array<Record<string, string>>> = {
  IT: [
    { "fullstack-dev": "Tommaso Gherardi", "devops": "Davide Morelli", "reddit-marketer": "Chiara Vannucci", "twitter-marketer": "Niccolo Ferrante", "cold-emailer": "Elena Bellandi", "seo-writer": "Ginevra Lattanzi", "ad-buyer": "Matilde Roversi", "content-writer": "Beatrice Nardelli", "lead-researcher": "Lorenzo Gatti", "outbound-caller": "Sara Mezzanotte", "account-buyer": "Riccardo Sanna", "bookkeeper": "Veronica Albrighi", designer: "Noemi Ruggieri" },
    { "fullstack-dev": "Emanuele Parisi", "devops": "Simone Battaglia", "reddit-marketer": "Aurora Greco", "twitter-marketer": "Federico Mazza", "cold-emailer": "Caterina Amato", "seo-writer": "Roberta Ferrara", "ad-buyer": "Alberto Silvestri", "content-writer": "Arianna Colombo", "lead-researcher": "Pietro Barbieri", "outbound-caller": "Serena Vitali", "account-buyer": "Luca Fontana", "bookkeeper": "Marta Morandi", designer: "Valentina Zanetti" },
    { "fullstack-dev": "Marco Benedetti", "devops": "Andrea Palmieri", "reddit-marketer": "Francesca Caruso", "twitter-marketer": "Alessandro Basile", "cold-emailer": "Ilaria Gallo", "seo-writer": "Costanza Sorrentino", "ad-buyer": "Giacomo Ferretti", "content-writer": "Ludovica Marchesi", "lead-researcher": "Valerio Gentili", "outbound-caller": "Camilla Pellegrini", "account-buyer": "Edoardo Cattaneo", "bookkeeper": "Giulia Wirth", designer: "Chiara Monti" },
  ],
  DEFAULT: [
    { "fullstack-dev": "Adrian Cole", "devops": "Miles Everett", "reddit-marketer": "Nora Flynn", "twitter-marketer": "Ethan Vale", "cold-emailer": "Claire Sutton", "seo-writer": "Juliette Moss", "ad-buyer": "Darren Holt", "content-writer": "Naomi Pierce", "lead-researcher": "Theo Warren", "outbound-caller": "Sabrina Lowe", "account-buyer": "Gavin Mercer", "bookkeeper": "Priya Nair", designer: "Elisa Romero" },
    { "fullstack-dev": "Soren Lindberg", "devops": "Tariq Bassam", "reddit-marketer": "Kira Johansson", "twitter-marketer": "Damon Cruz", "cold-emailer": "Layla Abrams", "seo-writer": "Ines Castellano", "ad-buyer": "Mateo Ivanov", "content-writer": "Thea Sandoval", "lead-researcher": "Ansel Rivera", "outbound-caller": "Maren Wolfe", "account-buyer": "Declan Torres", "bookkeeper": "Nadia Kowalski", designer: "Zara Ashford" },
    { "fullstack-dev": "Lucien Dubois", "devops": "Kai Tanaka", "reddit-marketer": "Samara Wells", "twitter-marketer": "Rowan Mercer", "cold-emailer": "Anika Patel", "seo-writer": "Sienna Cole", "ad-buyer": "Elliot Chen", "content-writer": "Mira Okafor", "lead-researcher": "Jordan Blackwell", "outbound-caller": "Rachel Nguyen", "account-buyer": "Amir Haddad", "bookkeeper": "Tessa Novak", designer: "Felix Moreau" },
  ],
};

const DEFAULT_SPECIALIST_NAMES_BY_COUNTRY: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries(SPECIALIST_NAME_POOLS_BY_COUNTRY).map(([k, v]) => [k, v[0]]),
);

const DEFAULT_COUNTRY_CONTEXT: FounderCountryContext = {
  country: "US",
  countryName: "United States",
};

const ITALIAN_FEMININE_FIRST_NAME_HINTS = new Set([
  "arianna", "aurora", "beatrice", "camilla", "caterina", "chiara", "costanza",
  "elena", "francesca", "ginevra", "giulia", "ilaria", "ludovica", "marta",
  "matilde", "noemi", "roberta", "sara", "serena", "sofia", "valentina", "veronica",
]);

const ITALIAN_MASCULINE_FIRST_NAME_HINTS = new Set([
  "alberto", "alessandro", "andrea", "carlo", "davide", "edoardo", "emanuele",
  "federico", "filippo", "giacomo", "jacopo", "leonardo", "lorenzo", "luca",
  "marco", "matteo", "niccolo", "pietro", "riccardo", "simone", "tommaso", "valerio",
]);

const GLOBAL_FEMININE_FIRST_NAME_HINTS = new Set([
  "akari", "amanda", "amara", "ananya", "anika", "avery", "beatriz", "blair",
  "camila", "camille", "carmen", "claire", "clara", "clémence", "dahye", "elena",
  "elisa", "fernanda", "freya", "ginevra", "hannah", "hina", "ines", "irene",
  "isabelle", "isla", "isadora", "johanna", "juliette", "kavya", "kira", "layla",
  "larissa", "leah", "lena", "lucía", "manon", "maren", "margaux", "mariana",
  "mathilde", "maya", "meera", "mio", "mira", "nadia", "naomi", "niamh",
  "nina", "nora", "noemi", "phoebe", "preet", "priya", "rachel", "riko",
  "sabrina", "sakura", "samara", "sienna", "sneha", "sofia", "sophie", "soyeon",
  "tanvi", "tessa", "thea", "valentina", "veronica", "yuna", "zara",
]);

const GLOBAL_MASCULINE_FIRST_NAME_HINTS = new Set([
  "adrian", "aditya", "aiden", "amir", "andrés", "ansel", "antoine", "arjun",
  "bastien", "caio", "caleb", "callum", "cameron", "damon", "darren", "declan",
  "derek", "diego", "elliot", "ethan", "ewan", "fabian", "felix", "florian",
  "gavin", "gustavo", "haruto", "henrique", "hugo", "hyunwoo", "idris",
  "ishaan", "jasper", "jiho", "jordan", "julian", "kai", "kaito", "karan",
  "lucien", "lukas", "marcus", "mateo", "matheus", "maximilian", "minjun",
  "miles", "niklas", "nikhil", "oliver", "owen", "pablo", "raj", "rafael",
  "raphaël", "ren", "reuben", "rohan", "rowan", "sebastian", "seojin",
  "siddharth", "soren", "sota", "takumi", "tariq", "theo", "thiago",
  "thomas", "tobias", "tommaso", "vikram", "yuki", "yuto",
]);

const EXECUTIVE_AVATAR_VARIANTS: AvatarVariant[] = [
  {
    framing: "tight head-and-shoulders crop",
    setting: "clean neutral office or studio backdrop",
    styling: "tailored business-casual look, understated blazer or knitwear",
    vibe: "polished, credible, calm, high-trust LinkedIn portrait",
  },
  {
    framing: "slightly wider chest-up portrait",
    setting: "bright modern workspace with soft background blur",
    styling: "smart professional outfit without looking overly formal",
    vibe: "approachable startup executive, confident but not stiff",
  },
  {
    framing: "close-up portrait with a bit of shoulder angle",
    setting: "natural window light in a real office",
    styling: "simple premium casual-professional clothing",
    vibe: "real founder or operator photo, natural and not overproduced",
  },
];

// ── Avatar pool randomizer attributes ──────────────────────────────────
// Inspired by diverse prompt randomizers — each slot gets a unique
// combination so the pool produces varied, realistic LinkedIn headshots.

const POOL_ETHNICITIES = [
  "East Asian", "South Asian", "Black", "white", "Latino", "Middle Eastern",
  "Southeast Asian", "mixed-race", "Indigenous", "Pacific Islander",
  "East African", "Mediterranean", "Central Asian", "Caribbean",
];
const POOL_SKIN_TONES: Array<"light" | "medium" | "deep"> = ["light", "medium", "deep"];
const POOL_HAIR_MAN = [
  "short cropped hair", "buzz cut", "slicked back hair", "curly hair",
  "undercut", "shoulder-length wavy hair", "short textured fade",
  "natural tight coils", "receding hairline with neat cut", "bald",
  "man bun", "short afro", "messy textured hair", "medium-length straight hair",
];
const POOL_HAIR_WOMAN = [
  "long flowing hair", "braids", "pixie cut", "shoulder-length wavy hair",
  "bob cut", "natural textured hair", "ponytail", "voluminous blowout",
  "tight coils", "curtain bangs with layered cut", "short cropped hair",
  "long straight hair", "loose curls", "updo bun",
];
const POOL_AGES = ["late 20s", "early 30s", "mid 30s", "late 30s", "early 40s", "mid 40s"];
const POOL_EXPRESSIONS = [
  "warm genuine smile", "confident closed-mouth smile",
  "soft approachable smile with head tilted slightly", "subtle knowing smirk",
  "friendly expression with relaxed eyes", "calm and composed look with direct eye contact",
  "natural mid-conversation expression", "genuine wide smile showing teeth",
];
const POOL_FRAMINGS = [
  "tight head-and-shoulders crop, centered",
  "classic head-and-shoulders portrait, slightly off-center",
  "upper body visible, confident posture",
  "close-up portrait with a bit of shoulder angle",
  "slightly wider chest-up portrait",
  "shot from slightly below, subtle power angle",
];
const POOL_BACKGROUNDS = [
  "blurred open-plan office with plants in background",
  "clean neutral studio backdrop, seamless",
  "modern coworking space with soft bokeh",
  "bright window-lit office interior",
  "floor-to-ceiling window with blurred cityscape",
  "warm indoor setting with natural light",
  "exposed brick wall, warm tone, shallow depth of field",
  "simple office wall with soft shadows",
  "outdoor urban setting, buildings softly blurred behind",
  "rooftop with blurred city skyline behind",
  "bookshelf with colorful books slightly out of focus",
  "plain white studio backdrop",
  "neutral premium grey backdrop",
  "coffee shop interior, warm ambient light",
];
const POOL_LIGHTING = [
  "golden hour warm sunlight from the side",
  "soft natural window light, flattering even shadows",
  "Rembrandt lighting with single source from 45 degrees",
  "diffused softbox lighting from front, clean and even",
  "natural overcast daylight, soft and even",
  "studio beauty light with subtle fill, catchlights in eyes",
  "backlit with gentle rim light creating hair highlight",
  "warm indoor mixed lighting, natural and relaxed feel",
];
const POOL_CAMERAS = [
  "Canon 5D Mark IV, 85mm f/1.4, shallow depth of field, creamy bokeh",
  "Sony A7R V, 70mm f/2, clean sharp detail with smooth background",
  "Hasselblad medium format, incredibly sharp, rich tonality",
  "Fujifilm X-T5, 56mm f/1.2, beautiful color science",
  "Nikon Z8, 85mm f/1.8, natural rendering, clean highlights",
  "Phase One IQ4, studio quality, superb detail and skin tones",
];
const POOL_CLOTHING_MAN = [
  "tailored dark navy suit jacket over light shirt, no tie",
  "wrinkled casual button-down, sleeves rolled up",
  "black turtleneck, sharp and minimal",
  "blazer over a crew-neck t-shirt",
  "clean premium henley shirt",
  "sharp casual overshirt in neutral tones",
  "fitted knit polo shirt",
  "modern startup casual: quarter-zip pullover",
  "linen shirt, relaxed but polished",
  "lightweight merino sweater over collared shirt",
];
const POOL_CLOTHING_WOMAN = [
  "tailored blazer with simple blouse underneath",
  "clean silk blouse with minimal jewelry",
  "smart casual crew-neck sweater",
  "structured jacket over a turtleneck",
  "professional wrap-style top",
  "classic button-down shirt, relaxed fit",
  "elegant knit top in a warm neutral tone",
  "modern startup style: sleek zip-up over simple top",
  "casual but polished layered outfit with light cardigan",
  "fitted crew-neck tee with delicate necklace",
];
const POOL_ACCESSORIES = [
  "", "", "", "", "", "", // weighted toward no accessory
  "wearing thin wire-frame glasses",
  "wearing thick-rimmed glasses",
  "wearing round tortoiseshell glasses",
  "with small stud earrings",
  "wearing a simple watch on wrist",
  "wearing a subtle necklace",
];

/**
 * Deterministic picker that guarantees even coverage across the array.
 * Uses stride-based offset to spread picks across the array evenly,
 * avoiding clustering that raw hash % length produces on small arrays.
 * The stride (golden-ratio-based) ensures near-uniform distribution.
 * Must not change across deploys or slot KV keys break.
 */
function poolPick<T>(arr: readonly T[], index: number, salt: number): T {
  // Golden-ratio stride ensures each (index, salt) pair maps to a well-spread position.
  // Different salts produce different starting offsets so attributes don't correlate.
  const stride = Math.round(arr.length * 0.618033988749895);
  const offset = ((salt * 7 + 3) * stride) % arr.length;
  return arr[(index * Math.max(stride, 1) + offset) % arr.length]!;
}

function skinToneForEthnicity(ethnicity: string, index: number): "light" | "medium" | "deep" {
  const lightLeaning = ["white", "East Asian"];
  const mediumLeaning = ["Latino", "Mediterranean", "South Asian", "Middle Eastern", "Central Asian", "Southeast Asian", "mixed-race"];
  const deepLeaning = ["Black", "East African", "Pacific Islander", "Caribbean", "Indigenous"];

  if (lightLeaning.includes(ethnicity)) return poolPick(["light", "light", "medium"] as const, index, 99);
  if (deepLeaning.includes(ethnicity)) return poolPick(["deep", "deep", "medium"] as const, index, 99);
  return poolPick(["medium", "medium", "light", "deep"] as const, index, 99);
}

function generateAvatarPoolSlots(): AvatarPoolSlotSpec[] {
  const slots: AvatarPoolSlotSpec[] = [];

  for (let i = 0; i < 50; i++) {
    const isMan = i < 25;
    const sex = isMan ? "man" as const : "woman" as const;
    const presentation = isMan ? "masculine" as const : "feminine" as const;
    // Alternate exec/spec: first 8 of each sex are exec, rest are spec
    const indexInSex = isMan ? i : i - 25;
    const roleClass: AvatarPoolRoleClass = indexInSex < 8 ? "executive" : "specialist";
    const ethnicity = poolPick(POOL_ETHNICITIES, i, 1);
    const skinTone = skinToneForEthnicity(ethnicity, i);
    const hair = poolPick(isMan ? POOL_HAIR_MAN : POOL_HAIR_WOMAN, i, 2);
    const age = poolPick(POOL_AGES, i, 3);
    const expression = poolPick(POOL_EXPRESSIONS, i, 4);
    const framing = poolPick(POOL_FRAMINGS, i, 5);
    const background = poolPick(POOL_BACKGROUNDS, i, 6);
    const lighting = poolPick(POOL_LIGHTING, i, 7);
    const camera = poolPick(POOL_CAMERAS, i, 8);
    const clothing = poolPick(isMan ? POOL_CLOTHING_MAN : POOL_CLOTHING_WOMAN, i, 9);
    const accessory = poolPick(POOL_ACCESSORIES, i, 10);

    slots.push({
      id: `pool-${sex}-${String(indexInSex).padStart(2, "0")}`,
      roleClass,
      presentation,
      sex,
      skinTone,
      ageBand: age,
      ethnicity,
      hair,
      clothing,
      expression,
      framing,
      background,
      lighting,
      camera,
      accessory,
    });
  }

  return slots;
}

const AVATAR_POOL_SLOTS: AvatarPoolSlotSpec[] = generateAvatarPoolSlots();

const SPECIALIST_AVATAR_VARIANTS: AvatarVariant[] = [
  {
    framing: "tight head-and-shoulders crop",
    setting: "simple office wall or soft neutral background",
    styling: "business-casual shirt or blouse",
    vibe: "professional but relaxed LinkedIn profile photo",
  },
  {
    framing: "slightly wider chest-up portrait",
    setting: "real coworking space with soft blur",
    styling: "smart-casual startup clothing, no suit",
    vibe: "competent operator, friendly and believable",
  },
  {
    framing: "medium close-up portrait",
    setting: "natural-light home office or desk area",
    styling: "clean casual outfit like a sweater, overshirt, or simple top",
    vibe: "authentic, modern, less formal but still profile-photo appropriate",
  },
  {
    framing: "portrait from a slightly off-center angle",
    setting: "outdoor urban background or building entrance with shallow depth of field",
    styling: "smart-casual jacket or layered outfit",
    vibe: "real person photo, slightly more casual, still suitable for LinkedIn",
  },
  {
    framing: "close-up portrait",
    setting: "warm indoor cafe or lounge style background with subtle blur",
    styling: "neat casual-professional outfit",
    vibe: "human, candid, approachable, not a stock-photo headshot",
  },
];

/**
 * Use Gemini to generate 7 realistic names from a specific country.
 * Names should be diverse (mix of genders) and feel like real people
 * who would work at a startup.
 */
export async function generateFoundingTeamNames(
  country: string,
  countryName: string,
  companyName: string,
  env: Env,
): Promise<GeneratedNames> {
  const prompt = `Generate 7 realistic full names for people from ${countryName} (${country}) who work at a startup called "${companyName}".

CRITICAL naming rules:
- Do NOT use the most famous or stereotypical names from ${countryName}. For example, if Italian, NEVER use Mario, Marco, Giulia, Rossi, Bianchi, Ferrari, Romano — these are the cliché defaults every AI picks.
- Instead, pick names that a real person from ${countryName} would actually have — interesting but not unusual. Think of names you'd find on a real LinkedIn profile of someone in their 20s-30s working at a tech startup.
- Use VARIED surnames — not the top-5 most common ones. Go for surnames ranked 50th-500th in popularity, not 1st-10th.
- Include a natural mix of male and female names (at least 3 of each gender).
- Each name should be first name + last name (as used in that culture).
- If the culture typically uses different name ordering (e.g. East Asian), use the local convention.
- Make each name feel like a distinct real person — avoid patterns like all names ending similarly.

Assign these roles (one name each):
1. CEO
2. CTO
3. Engineer 1
4. Engineer 2
5. QA Lead
6. API Key Agent (a technical specialist)
7. CMO

Respond in EXACTLY this JSON format, nothing else:
{
  "ceo": "Full Name",
  "cto": "Full Name",
  "engineer1": "Full Name",
  "engineer2": "Full Name",
  "qa_lead": "Full Name",
  "api_key_agent": "Full Name",
  "cmo": "Full Name"
}`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-preview:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.9, // higher temp for name diversity
        },
      }),
    },
  );

  if (!resp.ok) {
    throw new Error(`Gemini name generation failed: ${resp.status}`);
  }

  const result = await resp.json() as any;
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("No text in Gemini name response");

  const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return JSON.parse(cleaned) as GeneratedNames;
}

/**
 * Map a founding role + index to the right key in GeneratedNames.
 */
export function getNameForRole(
  names: GeneratedNames,
  role: FoundingRole,
  title: string,
): string {
  switch (role) {
    case "ceo": return names.ceo;
    case "cto": return names.cto;
    case "engineer":
      return title.includes("2") ? names.engineer2 : names.engineer1;
    case "qa_lead": return names.qa_lead;
    case "api_key_agent": return names.api_key_agent;
    case "cmo": return names.cmo;
    default: return "Agent";
  }
}

export async function generateSpecialistAgentName(
  country: string,
  countryName: string,
  companyName: string,
  blueprintId: string,
  roleTitle: string,
  existingNames: string[],
  env: Env,
): Promise<string> {
  const fallback = defaultSpecialistHumanName(blueprintId, roleTitle, country, countryName);

  if (!env.GEMINI_API_KEY) {
    return fallback;
  }

  const prompt = `Generate 1 realistic full name for a ${roleTitle} from ${countryName} (${country}) who just joined a startup called "${companyName}".

CRITICAL naming rules:
- Return a real human first name + last name, not a job label.
- Do NOT use cliché default names for ${countryName}.
- Avoid these existing company names exactly: ${existingNames.join(", ") || "none"}.
- Keep the name culturally appropriate for ${countryName}.
- Make it feel like a believable LinkedIn profile for someone in their 20s-30s.

Respond in EXACTLY this JSON format, nothing else:
{
  "name": "Full Name"
}`;

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-preview:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.9,
          },
        }),
      },
    );

    if (!resp.ok) {
      throw new Error(`Gemini specialist name generation failed: ${resp.status}`);
    }

    const result = await resp.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error("No text in specialist name response");
    }

    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned) as SingleGeneratedName;
    const generated = parsed.name?.trim();
    if (!generated || existingNames.includes(generated)) {
      return fallback;
    }

    return generated;
  } catch (err) {
    console.warn(
      `[identity] Falling back to default name for ${blueprintId}:`,
      err instanceof Error ? err.message : err,
    );
    return fallback;
  }
}

export function defaultSpecialistHumanName(
  blueprintId: string,
  fallbackLabel?: string,
  country?: string,
  countryName?: string,
): string {
  const normalizedCountry = normalizeCountryCode(country, countryName);
  const pool = SPECIALIST_NAME_POOLS_BY_COUNTRY[normalizedCountry]
    || SPECIALIST_NAME_POOLS_BY_COUNTRY.DEFAULT;
  const chosen = pool[Math.floor(Math.random() * pool.length)];

  return chosen[blueprintId]
    || DEFAULT_SPECIALIST_NAMES_BY_COUNTRY.DEFAULT[blueprintId]
    || fallbackLabel
    || "Agent";
}

export function defaultFoundingTeamNamesForCountry(
  country?: string,
  countryName?: string,
): GeneratedNames {
  const normalizedCountry = normalizeCountryCode(country, countryName);
  const pool = FOUNDING_NAME_POOLS_BY_COUNTRY[normalizedCountry]
    || FOUNDING_NAME_POOLS_BY_COUNTRY.DEFAULT;
  return pickRandomNameSet(pool);
}

export function avatarGenerationEnabled(env: Pick<Env, "GEMINI_API_KEY" | "OPENROUTER_API_KEY">): boolean {
  return Boolean(env.OPENROUTER_API_KEY || env.GEMINI_API_KEY);
}

export async function resolveFounderCountryContext(
  env: Pick<Env, "DB" | "CLERK_SECRET_KEY">,
  userId: string,
): Promise<FounderCountryContext> {
  const profile = await env.DB.prepare(
    `SELECT country, country_name
     FROM user_profiles
     WHERE user_id = ?
     LIMIT 1`,
  ).bind(userId).first<{ country: string | null; country_name: string | null }>();

  if (profile?.country || profile?.country_name) {
    return {
      country: profile?.country || normalizeCountryCode(undefined, profile?.country_name || undefined),
      countryName: profile?.country_name || countryNameForCode(profile?.country || undefined),
    };
  }

  const inferred = await inferFounderCountryFromClerk(env, userId);
  return inferred ?? DEFAULT_COUNTRY_CONTEXT;
}

function countryNameForCode(code?: string): string {
  switch ((code || "").trim().toUpperCase()) {
    case "IT":
      return "Italy";
    case "US":
      return "United States";
    default:
      return "United States";
  }
}

async function inferFounderCountryFromClerk(
  env: Pick<Env, "CLERK_SECRET_KEY">,
  userId: string,
): Promise<FounderCountryContext | null> {
  if (!env.CLERK_SECRET_KEY) {
    return null;
  }

  try {
    const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
      headers: {
        Authorization: `Bearer ${env.CLERK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return null;
    }

    const user = await response.json() as {
      first_name?: string | null;
      last_name?: string | null;
      email_addresses?: Array<{ email_address?: string | null }>;
    };

    const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
    const email = user.email_addresses?.[0]?.email_address?.trim() || null;
    return inferCountryFromIdentity(fullName, email);
  } catch {
    return null;
  }
}

function inferCountryFromIdentity(
  fullName: string,
  email: string | null,
): FounderCountryContext | null {
  const tokens = fullName
    .toLowerCase()
    .split(/[\s'-]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const hasItalianFirstName = tokens.some((token) =>
    ITALIAN_FEMININE_FIRST_NAME_HINTS.has(token) || ITALIAN_MASCULINE_FIRST_NAME_HINTS.has(token),
  );
  const hasItalianSurnamePattern = tokens.some((token) =>
    /(?:ini|oni|ari|eri|ori|etti|etti|etti|ucci|azzi|ello|ella|ante|anti|ardo|aldi|ucci|ezzi|azzi|assi|essi|ucci|etti|rini|tori|sori|ferraris)$/.test(token),
  );
  const emailSuggestsItaly = typeof email === "string" && /\.it$/i.test(email);

  if (hasItalianFirstName || hasItalianSurnamePattern || emailSuggestsItaly) {
    return { country: "IT", countryName: "Italy" };
  }

  return null;
}

type AvatarGenerationMode = "automatic" | "manual";

interface AvatarGenerationOptions {
  agentId?: string;
  budget?: { remaining: number };
  mode?: AvatarGenerationMode;
  countryCode?: string;
}

interface AvatarAttemptState {
  autoAttempts: number;
  completed: boolean;
  lastAttemptAt: string | null;
}

const OPENROUTER_AVATAR_MODEL = "google/gemini-3.1-flash-image-preview";
const DIRECT_GEMINI_AVATAR_MODEL = "gemini-3.1-flash-image-preview";
const MAX_AUTO_AVATAR_ATTEMPTS_PER_AGENT = 2;
const AVATAR_REQUEST_TIMEOUT_MS = 30_000;
const AVATAR_ATTEMPT_KEY_PREFIX = "avatar:attempts:";
const AVATAR_POOL_TARGET_READY = AVATAR_POOL_SLOTS.length;
const AVATAR_POOL_DEFAULT_MAX_GENERATE = 6;
const AVATAR_POOL_REFILL_LOCK_KEY = "avatar-pool:refill-lock";
const AVATAR_POOL_REFILL_LOCK_TTL_SECONDS = 180;

function avatarPoolImageKey(slotId: string): string {
  return `avatar-pool:image:${slotId}`;
}

function avatarPoolMetaKey(slotId: string): string {
  return `avatar-pool:meta:${slotId}`;
}

function avatarRoleClass(role: string): AvatarPoolRoleClass {
  const normalized = role.trim().toLowerCase();
  return /(?:^| )(ceo|cto|cmo|chief)(?:$| )/.test(normalized) ? "executive" : "specialist";
}

function avatarPoolTags(spec: AvatarPoolSlotSpec): string[] {
  return [
    `role:${spec.roleClass}`,
    `sex:${spec.sex}`,
    `presentation:${spec.presentation}`,
    `skinTone:${spec.skinTone}`,
    `ageBand:${spec.ageBand}`,
    `ethnicity:${spec.ethnicity}`,
  ];
}

function defaultAvatarPoolState(spec: AvatarPoolSlotSpec): AvatarPoolSlotState {
  return {
    slotId: spec.id,
    roleClass: spec.roleClass,
    tags: avatarPoolTags(spec),
    status: "warming",
    lastGeneratedAt: null,
    lastClaimedAt: null,
    generationCount: 0,
    contentType: "image/png",
  };
}

async function readAvatarPoolState(
  spec: AvatarPoolSlotSpec,
  env: Pick<Env, "AUTOMATON_KV">,
): Promise<AvatarPoolSlotState> {
  const raw = await env.AUTOMATON_KV.get(avatarPoolMetaKey(spec.id));
  if (!raw) {
    return defaultAvatarPoolState(spec);
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AvatarPoolSlotState>;
    return {
      slotId: spec.id,
      roleClass: spec.roleClass,
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag): tag is string => typeof tag === "string") : avatarPoolTags(spec),
      status: parsed.status === "ready" ? "ready" : "warming",
      lastGeneratedAt: typeof parsed.lastGeneratedAt === "string" ? parsed.lastGeneratedAt : null,
      lastClaimedAt: typeof parsed.lastClaimedAt === "string" ? parsed.lastClaimedAt : null,
      generationCount: Number.isFinite(parsed.generationCount) ? Number(parsed.generationCount) : 0,
      contentType: typeof parsed.contentType === "string" && parsed.contentType ? parsed.contentType : "image/png",
    };
  } catch {
    return defaultAvatarPoolState(spec);
  }
}

async function writeAvatarPoolState(
  state: AvatarPoolSlotState,
  env: Pick<Env, "AUTOMATON_KV">,
): Promise<void> {
  await env.AUTOMATON_KV.put(avatarPoolMetaKey(state.slotId), JSON.stringify(state));
}

async function tryAcquireAvatarPoolLock(
  env: Pick<Env, "AUTOMATON_KV">,
): Promise<boolean> {
  const existing = await env.AUTOMATON_KV.get(AVATAR_POOL_REFILL_LOCK_KEY);
  if (existing) {
    return false;
  }
  await env.AUTOMATON_KV.put(AVATAR_POOL_REFILL_LOCK_KEY, new Date().toISOString(), {
    expirationTtl: AVATAR_POOL_REFILL_LOCK_TTL_SECONDS,
  });
  return true;
}

function buildAvatarPoolPrompt(spec: AvatarPoolSlotSpec, generationCount: number): string {
  const seed = `${spec.id}:${generationCount}:${new Date().toISOString().slice(0, 13)}`;

  let prompt = `LinkedIn profile picture of a ${spec.ageBand} ${spec.ethnicity} ${spec.sex} with ${spec.hair}`;
  if (spec.accessory) prompt += `, ${spec.accessory}`;
  prompt += `. ${spec.clothing}. ${spec.expression}. ${spec.framing}. ${spec.background}. ${spec.lighting}. Shot on ${spec.camera}.`;
  prompt += ` The image should look like a real LinkedIn profile photo — photorealistic, natural, not AI-looking.`;

  return [
    prompt,
    "",
    "Requirements:",
    "- exactly one person, no extra people in the frame",
    "- realistic camera optics and natural lighting",
    "- believable face, posture, and proportions — no uncanny smoothness",
    "- no text, no logos, no watermarks",
    "- no illustration, no 3D render, no cartoon",
    "- suitable for a professional LinkedIn or company profile photo",
    `Variation seed: ${seed}`,
  ].join("\n");
}

function inferAvatarPresentation(
  agentName: string,
  country?: string,
  countryName?: string,
): AvatarPoolSlotSpec["presentation"] {
  const firstName = agentName
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase()
    .replace(/[^a-z]/g, "");
  if (!firstName) {
    // Default to masculine when name is unknown — pool has no androgynous slots
    return "masculine";
  }

  const normalizedCountry = normalizeCountryCode(country, countryName);
  if (normalizedCountry === "IT") {
    if (ITALIAN_FEMININE_FIRST_NAME_HINTS.has(firstName)) return "feminine";
    if (ITALIAN_MASCULINE_FIRST_NAME_HINTS.has(firstName)) return "masculine";
  }

  if (GLOBAL_FEMININE_FIRST_NAME_HINTS.has(firstName)) return "feminine";
  if (GLOBAL_MASCULINE_FIRST_NAME_HINTS.has(firstName)) return "masculine";
  // Default to masculine for unrecognized names
  return "masculine";
}

function preferredSkinTonesForCountry(
  country?: string,
  countryName?: string,
): AvatarPoolSlotSpec["skinTone"][] {
  const normalizedCountry = normalizeCountryCode(country, countryName);
  switch (normalizedCountry) {
    case "IT":
      return ["light", "medium"];
    default:
      return ["light", "medium", "deep"];
  }
}

function avatarPoolWarmPriority(slotId: string): number {
  // Warm executives first (lower index = used for CEO/CTO/CMO), alternating man/woman.
  // Slots pool-man-00..07 are exec, pool-woman-00..07 are exec, rest are specialist.
  // Interleave man/woman so both genders warm quickly.
  const warmOrder = [
    "pool-man-00", "pool-woman-00", "pool-man-01", "pool-woman-01",
    "pool-man-02", "pool-woman-02", "pool-man-03", "pool-woman-03",
    "pool-man-04", "pool-woman-04", "pool-man-05", "pool-woman-05",
    "pool-man-06", "pool-woman-06", "pool-man-07", "pool-woman-07",
    "pool-man-08", "pool-woman-08", "pool-man-09", "pool-woman-09",
    "pool-man-10", "pool-woman-10", "pool-man-11", "pool-woman-11",
    "pool-man-12", "pool-woman-12", "pool-man-13", "pool-woman-13",
    "pool-man-14", "pool-woman-14", "pool-man-15", "pool-woman-15",
    "pool-man-16", "pool-woman-16", "pool-man-17", "pool-woman-17",
    "pool-man-18", "pool-woman-18", "pool-man-19", "pool-woman-19",
    "pool-man-20", "pool-woman-20", "pool-man-21", "pool-woman-21",
    "pool-man-22", "pool-woman-22", "pool-man-23", "pool-woman-23",
    "pool-man-24", "pool-woman-24",
  ];
  const index = warmOrder.indexOf(slotId);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

interface AvatarPoolClaimPreferences {
  agentName?: string;
  country?: string;
  countryName?: string;
}

function scoreAvatarPoolSlot(
  slot: AvatarPoolSlotSpec,
  preferences: AvatarPoolClaimPreferences,
): number {
  const preferredPresentation = preferences.agentName
    ? inferAvatarPresentation(preferences.agentName, preferences.country, preferences.countryName)
    : "masculine";
  const preferredSkinTones = preferredSkinTonesForCountry(preferences.country, preferences.countryName);

  let score = 0;
  // Sex/presentation match is the strongest signal — must match name gender
  if (slot.presentation === preferredPresentation) {
    score += 10;
  }

  if (preferredSkinTones.includes(slot.skinTone)) {
    score += 3;
  }

  if (slot.roleClass === "executive" && slot.ageBand !== "late 20s") {
    score += 1;
  }

  return score;
}

async function putAvatarBinary(
  key: string,
  value: ArrayBuffer,
  contentType: string,
  env: Pick<Env, "AUTOMATON_KV">,
): Promise<void> {
  await env.AUTOMATON_KV.put(key, value, {
    metadata: { contentType },
  });
}

export async function claimAvatarFromPool(
  agentId: string,
  role: string,
  env: Pick<Env, "AUTOMATON_KV">,
  usedSlotIds: Set<string> = new Set(),
  preferences: AvatarPoolClaimPreferences = {},
): Promise<{ slotId: string; avatarUrl: string } | null> {
  const roleClass = avatarRoleClass(role);
  const states = await Promise.all(
    AVATAR_POOL_SLOTS
      .filter((slot) => slot.roleClass === roleClass)
      .map(async (slot) => ({
        slot,
        state: await readAvatarPoolState(slot, env),
      })),
  );

  const candidates = states
    .filter(({ slot, state }) => state.status === "ready" && !usedSlotIds.has(slot.id))
    .sort((left, right) => {
      const scoreDelta = scoreAvatarPoolSlot(right.slot, preferences) - scoreAvatarPoolSlot(left.slot, preferences);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      const leftTime = left.state.lastClaimedAt || left.state.lastGeneratedAt || "";
      const rightTime = right.state.lastClaimedAt || right.state.lastGeneratedAt || "";
      return leftTime.localeCompare(rightTime);
    });

  for (const candidate of candidates) {
    const slotId = candidate.slot.id;
    const { value, metadata } = await env.AUTOMATON_KV.getWithMetadata<{ contentType?: string }>(
      avatarPoolImageKey(slotId),
      { type: "arrayBuffer" },
    );
    if (!value) {
      await writeAvatarPoolState(
        {
          ...candidate.state,
          status: "warming",
        },
        env,
      );
      continue;
    }

    const contentType = metadata?.contentType || candidate.state.contentType || "image/png";
    await putAvatarBinary(`avatar:${agentId}`, value, contentType, env);
    await writeAvatarPoolState(
      {
        ...candidate.state,
        status: "warming",
        lastClaimedAt: new Date().toISOString(),
        contentType,
      },
      env,
    );
    usedSlotIds.add(slotId);
    return {
      slotId,
      avatarUrl: `/api/avatars/${agentId}`,
    };
  }

  return null;
}

export async function ensureAvatarPoolWarm(
  env: Pick<Env, "AUTOMATON_KV" | "OPENROUTER_API_KEY" | "GEMINI_API_KEY">,
  options: {
    minimumReady?: number;
    maxGenerate?: number;
  } = {},
): Promise<{ ready: number; generated: number }> {
  const states = await Promise.all(
    AVATAR_POOL_SLOTS.map(async (slot) => {
      const state = await readAvatarPoolState(slot, env);
      const hasImage = await env.AUTOMATON_KV.get(avatarPoolImageKey(slot.id), { type: "arrayBuffer" });
      return {
        slot,
        state,
        ready: state.status === "ready" && hasImage !== null,
      };
    }),
  );

  let readyCount = states.filter((entry) => entry.ready).length;
  const minimumReady = Math.min(options.minimumReady ?? AVATAR_POOL_TARGET_READY, AVATAR_POOL_SLOTS.length);
  if (readyCount >= minimumReady || !avatarGenerationEnabled(env)) {
    return { ready: readyCount, generated: 0 };
  }

  const locked = await tryAcquireAvatarPoolLock(env);
  if (!locked) {
    return { ready: readyCount, generated: 0 };
  }

  let generated = 0;
  const maxGenerate = Math.max(1, options.maxGenerate ?? AVATAR_POOL_DEFAULT_MAX_GENERATE);
  const slotsToFill = states
    .filter((entry) => !entry.ready)
    .sort((left, right) => {
      const warmPriorityDelta = avatarPoolWarmPriority(left.slot.id) - avatarPoolWarmPriority(right.slot.id);
      if (warmPriorityDelta !== 0) {
        return warmPriorityDelta;
      }
      return left.state.generationCount - right.state.generationCount;
    })
    .slice(0, maxGenerate);

  for (const entry of slotsToFill) {
    const nextGenerationCount = entry.state.generationCount + 1;
    const prompt = buildAvatarPoolPrompt(entry.slot, nextGenerationCount);
    const base64 = env.OPENROUTER_API_KEY
      ? await generateAvatarViaOpenRouter(prompt, env.OPENROUTER_API_KEY)
        || (env.GEMINI_API_KEY ? await generateAvatarViaGemini(prompt, env.GEMINI_API_KEY) : null)
      : env.GEMINI_API_KEY
        ? await generateAvatarViaGemini(prompt, env.GEMINI_API_KEY)
        : null;
    if (!base64) {
      continue;
    }

    const binaryData = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    await putAvatarBinary(avatarPoolImageKey(entry.slot.id), binaryData.buffer, "image/png", env);
    await writeAvatarPoolState(
      {
        slotId: entry.slot.id,
        roleClass: entry.slot.roleClass,
        tags: avatarPoolTags(entry.slot),
        status: "ready",
        lastGeneratedAt: new Date().toISOString(),
        lastClaimedAt: entry.state.lastClaimedAt,
        generationCount: nextGenerationCount,
        contentType: "image/png",
      },
      env,
    );
    generated += 1;
  }

  readyCount = (
    await Promise.all(
      AVATAR_POOL_SLOTS.map(async (slot) => {
        const state = await readAvatarPoolState(slot, env);
        if (state.status !== "ready") return false;
        return (await env.AUTOMATON_KV.get(avatarPoolImageKey(slot.id), { type: "arrayBuffer" })) !== null;
      }),
    )
  ).filter(Boolean).length;

  return { ready: readyCount, generated };
}

async function readAvatarAttemptState(
  agentId: string,
  env: Pick<Env, "AUTOMATON_KV">,
): Promise<AvatarAttemptState> {
  const raw = await env.AUTOMATON_KV.get(`${AVATAR_ATTEMPT_KEY_PREFIX}${agentId}`);
  if (!raw) {
    return { autoAttempts: 0, completed: false, lastAttemptAt: null };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AvatarAttemptState>;
    return {
      autoAttempts: Number(parsed.autoAttempts ?? 0),
      completed: Boolean(parsed.completed),
      lastAttemptAt: typeof parsed.lastAttemptAt === "string" ? parsed.lastAttemptAt : null,
    };
  } catch {
    return { autoAttempts: 0, completed: false, lastAttemptAt: null };
  }
}

async function reserveAutomaticAvatarAttempt(
  agentId: string,
  env: Pick<Env, "AUTOMATON_KV">,
): Promise<boolean> {
  const state = await readAvatarAttemptState(agentId, env);
  if (state.completed || state.autoAttempts >= MAX_AUTO_AVATAR_ATTEMPTS_PER_AGENT) {
    return false;
  }
  const next: AvatarAttemptState = {
    autoAttempts: state.autoAttempts + 1,
    completed: false,
    lastAttemptAt: new Date().toISOString(),
  };
  await env.AUTOMATON_KV.put(`${AVATAR_ATTEMPT_KEY_PREFIX}${agentId}`, JSON.stringify(next));
  return true;
}

async function markAvatarAttemptComplete(
  agentId: string,
  env: Pick<Env, "AUTOMATON_KV">,
): Promise<void> {
  const state = await readAvatarAttemptState(agentId, env);
  const next: AvatarAttemptState = {
    autoAttempts: Math.max(1, state.autoAttempts),
    completed: true,
    lastAttemptAt: new Date().toISOString(),
  };
  await env.AUTOMATON_KV.put(`${AVATAR_ATTEMPT_KEY_PREFIX}${agentId}`, JSON.stringify(next));
}

async function generateAvatarViaOpenRouter(
  prompt: string,
  apiKey: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AVATAR_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENROUTER_AVATAR_MODEL,
        messages: [
          {
            role: "system",
            content: "Return exactly one realistic professional profile portrait image and no extra commentary.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        modalities: ["image", "text"],
        image_config: {
          image_size: "0.5K",
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      console.error(`[avatar] OpenRouter generation failed: HTTP ${response.status} - ${errBody.slice(0, 200)}`);
      return null;
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: {
          images?: Array<{
            image_url?: { url?: string };
            imageUrl?: { url?: string };
          }>;
          content?: Array<{
            type?: string;
            image_url?: { url?: string };
          }>;
        };
      }>;
    };
    const message = data.choices?.[0]?.message;
    const images = message?.images;
    if (Array.isArray(images)) {
      for (const image of images) {
        const dataUrl = image.imageUrl?.url || image.image_url?.url;
        const match = dataUrl?.match(/^data:image\/(?:png|jpeg|webp);base64,(.+)$/);
        if (match?.[1]) {
          return match[1];
        }
      }
    }

    const content = message?.content;
    if (!Array.isArray(content)) {
      console.warn("[avatar] OpenRouter returned no multimodal content array");
      return null;
    }

    for (const part of content) {
      const dataUrl = part.type === "image_url" ? part.image_url?.url : undefined;
      const match = dataUrl?.match(/^data:image\/(?:png|jpeg|webp);base64,(.+)$/);
      if (match?.[1]) {
        return match[1];
      }
    }

    console.warn("[avatar] OpenRouter returned no image payload");
    return null;
  } catch (err) {
    console.error("[avatar] OpenRouter request failed:", err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function generateAvatarViaGemini(
  prompt: string,
  apiKey: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AVATAR_REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${DIRECT_GEMINI_AVATAR_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ["IMAGE", "TEXT"],
          },
        }),
        signal: controller.signal,
      },
    );

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      console.error(`[avatar] Gemini generation failed: HTTP ${resp.status} - ${errBody.slice(0, 200)}`);
      return null;
    }

    const result = await resp.json() as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: {
              mimeType?: string;
              data?: string;
            };
          }>;
        };
      }>;
    };
    const parts = result.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find((part) => part.inlineData?.mimeType?.startsWith("image/"));
    return imagePart?.inlineData?.data ?? null;
  } catch (err) {
    console.error("[avatar] Gemini request failed:", err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateAgentAvatar(
  agentName: string,
  role: string,
  countryName: string,
  env: Env,
  options: AvatarGenerationOptions = {},
): Promise<string | null> {
  if (options.budget) {
    if (options.budget.remaining <= 0) {
      console.warn(`[avatar] Skipping generation for ${agentName}: launch avatar budget exhausted`);
      return null;
    }
    options.budget.remaining -= 1;
  }

  if (options.mode !== "manual" && options.agentId) {
    const reserved = await reserveAutomaticAvatarAttempt(options.agentId, env);
    if (!reserved) {
      console.warn(`[avatar] Skipping generation for ${agentName}: automatic attempt cap reached`);
      return null;
    }
  }

  const variant = selectAvatarVariant(agentName, role);
  const presentation = inferAvatarPresentation(agentName, options.countryCode, countryName);
  const plausibleSkinTones = preferredSkinTonesForCountry(options.countryCode, countryName);
  const prompt = [
    `Photorealistic profile photo of ${agentName}, a ${role} from ${countryName} working at a tech startup.`,
    "",
    "The image should look like a real LinkedIn profile picture, not a glossy AI corporate headshot.",
    `Presentation: ${presentation}.`,
    `Framing: ${variant.framing}.`,
    `Setting: ${variant.setting}.`,
    `Styling: ${variant.styling}.`,
    `Overall vibe: ${variant.vibe}.`,
    "",
    "Requirements:",
    "- exactly one real-looking person",
    "- natural skin texture, natural camera depth of field, realistic lighting",
    "- believable expression and posture",
    `- the person should feel visually plausible for the name "${agentName}" and country "${countryName}"`,
    `- preferred skin tone range for this identity: ${plausibleSkinTones.join(" or ")}`,
    "- no exaggerated beauty retouching, no plastic skin, no uncanny symmetry",
    "- no illustration, no CGI, no surrealism, no stock-photo stiffness",
    "- suitable for a real professional social profile, but not every portrait should feel equally formal",
  ].join("\n");

  const avatarBase64 = env.OPENROUTER_API_KEY
    ? await generateAvatarViaOpenRouter(prompt, env.OPENROUTER_API_KEY)
      || (env.GEMINI_API_KEY ? await generateAvatarViaGemini(prompt, env.GEMINI_API_KEY) : null)
    : env.GEMINI_API_KEY
      ? await generateAvatarViaGemini(prompt, env.GEMINI_API_KEY)
      : null;

  if (avatarBase64) {
    if (options.agentId) {
      await markAvatarAttemptComplete(options.agentId, env);
    }
    return avatarBase64;
  }

  const provider = env.OPENROUTER_API_KEY ? "OpenRouter" : env.GEMINI_API_KEY ? "Gemini" : "none";
  console.error(
    `[avatar] Avatar generation failed for agent ${options.agentId ?? "unknown"} (${agentName}, role=${role}): all providers returned null (provider=${provider})`,
  );
  return null;
}

function selectAvatarVariant(agentName: string, role: string): AvatarVariant {
  const roleLabel = role.toLowerCase();
  const isExecutive =
    roleLabel.includes("ceo")
    || roleLabel.includes("cto")
    || roleLabel.includes("cmo")
    || roleLabel.includes("chief");
  const variants = isExecutive ? EXECUTIVE_AVATAR_VARIANTS : SPECIALIST_AVATAR_VARIANTS;
  const index = deterministicHash(`${agentName}:${role}`) % variants.length;
  return variants[index];
}

function deterministicHash(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function normalizeCountryCode(country?: string, countryName?: string): string {
  const trimmed = country?.trim().toUpperCase();
  if (trimmed) {
    return trimmed;
  }

  const normalizedName = countryName?.trim().toLowerCase();
  if (normalizedName === "italy" || normalizedName === "italia") {
    return "IT";
  }

  return "DEFAULT";
}

/**
 * Store an avatar in KV and return a URL that can be served.
 */
export async function storeAvatar(
  agentId: string,
  base64Data: string,
  env: Env,
): Promise<string> {
  const key = `avatar:${agentId}`;
  // Store as binary
  const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
  await env.AUTOMATON_KV.put(key, binaryData, {
    metadata: { contentType: "image/png" },
  });
  // Return a path that the API can serve
  return `/api/avatars/${agentId}`;
}

export async function hasStoredAvatar(
  agentId: string,
  env: Pick<Env, "AUTOMATON_KV">,
): Promise<boolean> {
  const key = `avatar:${agentId}`;
  const value = await env.AUTOMATON_KV.get(key, { type: "arrayBuffer" });
  return value !== null;
}
