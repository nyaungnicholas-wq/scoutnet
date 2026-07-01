/* The vertical catalog. ScoutNet targets recession-resistant local trades — the
   kind with steady, recurring demand (people still need a plumber, a dentist, a
   tax return in a downturn). `incomePrior` is a 0–1 stability weight folded into
   the income score; `places` are Google Places text-search terms; `osm` are the
   OpenStreetMap key=value tags the free Overpass provider queries. */

export type VerticalKey =
  | "all"
  | "hvac"
  | "plumbing"
  | "electrical"
  | "roofing"
  | "landscaping"
  | "auto_repair"
  | "dentist"
  | "law_firm"
  | "accounting"
  | "med_spa"
  | "veterinary"
  | "restaurant"
  | "generic";

export type Vertical = {
  key: VerticalKey;
  label: string;
  /** 0–1: how recession-resistant / steady the revenue tends to be. */
  incomePrior: number;
  placesQuery: string;
  /** OpenStreetMap tag filters, e.g. ["craft=hvac", "shop=hvac"]. */
  osm: string[];
  /** Trade nouns used to confirm a website really belongs to this vertical. */
  keywords: string[];
};

export const VERTICALS: Vertical[] = [
  { key: "all", label: "All local businesses (broad sweep)", incomePrior: 0.6, placesQuery: "business", osm: ["shop", "office", "craft", "amenity=restaurant", "amenity=cafe", "amenity=fast_food", "amenity=bar", "amenity=pub", "amenity=dentist", "amenity=doctors", "amenity=clinic", "amenity=veterinary", "amenity=pharmacy", "amenity=car_repair", "amenity=fuel", "amenity=bank"], keywords: [] },
  { key: "hvac", label: "HVAC / heating & cooling", incomePrior: 0.9, placesQuery: "HVAC contractor", osm: ['craft=hvac', 'shop=hvac'], keywords: ["hvac", "heating", "cooling", "air conditioning", "furnace", "ac repair"] },
  { key: "plumbing", label: "Plumbing", incomePrior: 0.92, placesQuery: "plumber", osm: ['craft=plumber', 'shop=plumber'], keywords: ["plumbing", "plumber", "drain", "sewer", "water heater", "leak"] },
  { key: "electrical", label: "Electrical", incomePrior: 0.88, placesQuery: "electrician", osm: ['craft=electrician'], keywords: ["electrical", "electrician", "wiring", "panel", "lighting"] },
  { key: "roofing", label: "Roofing", incomePrior: 0.82, placesQuery: "roofing contractor", osm: ['craft=roofer'], keywords: ["roofing", "roofer", "shingle", "gutter", "re-roof"] },
  { key: "landscaping", label: "Landscaping / lawn care", incomePrior: 0.7, placesQuery: "landscaping service", osm: ['shop=garden_centre', 'craft=gardener', 'landuse=landscaping'], keywords: ["landscaping", "lawn care", "hardscape", "irrigation", "tree service"] },
  { key: "auto_repair", label: "Auto repair", incomePrior: 0.85, placesQuery: "auto repair shop", osm: ['shop=car_repair'], keywords: ["auto repair", "mechanic", "brakes", "transmission", "oil change", "tire"] },
  { key: "dentist", label: "Dental practice", incomePrior: 0.93, placesQuery: "dentist", osm: ['amenity=dentist', 'healthcare=dentist'], keywords: ["dental", "dentist", "orthodont", "implant", "teeth", "hygienist"] },
  { key: "law_firm", label: "Law firm", incomePrior: 0.9, placesQuery: "law firm attorney", osm: ['office=lawyer'], keywords: ["law firm", "attorney", "lawyer", "litigation", "practice areas", "counsel"] },
  { key: "accounting", label: "Accounting / CPA", incomePrior: 0.94, placesQuery: "accountant CPA", osm: ['office=accountant'], keywords: ["accounting", "cpa", "bookkeeping", "tax preparation", "payroll", "audit"] },
  { key: "med_spa", label: "Med spa / aesthetics", incomePrior: 0.72, placesQuery: "med spa", osm: ['shop=beauty', 'leisure=spa', 'amenity=clinic'], keywords: ["med spa", "botox", "filler", "laser", "aesthetic", "skin"] },
  { key: "veterinary", label: "Veterinary clinic", incomePrior: 0.9, placesQuery: "veterinary clinic", osm: ['amenity=veterinary'], keywords: ["veterinary", "veterinarian", "animal hospital", "pet", "vet clinic"] },
  { key: "restaurant", label: "Restaurant", incomePrior: 0.55, placesQuery: "restaurant", osm: ['amenity=restaurant'], keywords: ["restaurant", "menu", "reservation", "catering", "dine"] },
  { key: "generic", label: "Other local business", incomePrior: 0.65, placesQuery: "local business", osm: ['shop=yes', 'office=company'], keywords: [] },
];

const BY_KEY = new Map(VERTICALS.map((v) => [v.key, v]));

export function getVertical(key: string): Vertical {
  return BY_KEY.get(key as VerticalKey) ?? BY_KEY.get("generic")!;
}

export function isVerticalKey(k: string): k is VerticalKey {
  return BY_KEY.has(k as VerticalKey);
}
