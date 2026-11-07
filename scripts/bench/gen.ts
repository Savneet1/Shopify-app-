/**
 * Phase 14.1 — deterministic synthetic catalog generator.
 *
 * Produces Shopify-bulk-style JSONL (the SAME shape `fetchBulkCatalog` returns)
 * so the benchmark loads data through the REAL sync→index build path
 * (`runFullSync` → parse → upsert → buildDocs → validate → activate). A fixed
 * seed makes the output byte-for-byte reproducible, so build/query numbers are
 * comparable across runs and machines.
 *
 * Distributions are realistic-ish (not uniform): a long-tail vendor/type mix,
 * 1–5 variants, log-spread prices, a facet metafield, collection membership,
 * and a slice of unavailable / draft / archived / unpublished / combined-listing
 * products so the hide/visibility paths are exercised at scale.
 *
 * Pure (no I/O, no DB) and self-tested for determinism.
 */

/** mulberry32: a tiny, fast, fully-deterministic 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GenOptions {
  size: number;      // number of PRODUCTS
  seed?: number;
}
export interface GenResult {
  productsJsonl: string;
  collectionsJsonl: string;
  productCount: number;
  stats: {
    active: number; draft: number; archived: number; unpublished: number;
    unavailable: number; combinedParents: number; combinedChildren: number;
    variants: number; collections: number;
  };
  /** A deterministic sample of query inputs drawn from the real data, so the
   * query sets hit terms/vendors/types/handles that actually exist. */
  samples: {
    terms: string[];        // real title words
    vendors: string[];
    types: string[];
    typos: string[];        // a real word with one transposed/dropped letter
    handles: string[];      // for recommendations seeds (gid)
    parentGids: string[];   // combined parents
    collectionGids: string[];
  };
}

const VENDORS = Array.from({ length: 40 }, (_, i) => `Vendor${i}`);
const TYPES = ["Shoe", "Shirt", "Jacket", "Hat", "Bag", "Watch", "Mug", "Lamp", "Chair", "Desk",
  "Phone", "Case", "Cable", "Headphones", "Speaker", "Bottle", "Knife", "Pan", "Towel", "Pillow",
  "Blanket", "Candle", "Soap", "Brush", "Mirror"];
const ADJ = ["Red", "Blue", "Green", "Classic", "Modern", "Vintage", "Premium", "Compact", "Deluxe",
  "Eco", "Travel", "Wireless", "Organic", "Leather", "Wooden", "Steel", "Matte", "Glossy", "Slim", "Rugged"];
const NOUN = ["Runner", "Trail", "Pro", "Lite", "Max", "Mini", "Plus", "Edge", "Core", "Flex",
  "Nova", "Prime", "Wave", "Pulse", "Aero", "Terra", "Lumen", "Vertex", "Zephyr", "Atlas"];
const MATERIALS = ["Cotton", "Wool", "Leather", "Silk", "Denim", "Linen", "Polyester", "Bamboo"];
const SIZES = ["XS", "S", "M", "L", "XL"];
const TAG_POOL = Array.from({ length: 150 }, (_, i) => `tag${i}`);

function pick<T>(r: () => number, arr: T[]): T { return arr[Math.floor(r() * arr.length)]; }
function priceOf(r: () => number): string {
  // log-spread 5.00 .. 500.00
  const v = Math.exp(Math.log(5) + r() * (Math.log(500) - Math.log(5)));
  return (Math.round(v * 100) / 100).toFixed(2);
}
function iso(day: number): string {
  // deterministic timestamps spread over ~3 years ending 2026-01-01
  const base = Date.UTC(2023, 0, 1) + day * 3600_000;
  return new Date(base).toISOString();
}

export function generateCatalog(opts: GenOptions): GenResult {
  const size = Math.max(0, Math.floor(opts.size));
  const r = mulberry32((opts.seed ?? 1337) >>> 0);
  const prodLines: string[] = [];
  const childLines: string[] = [];
  const collLines: string[] = [];

  const numCollections = Math.max(1, Math.min(200, Math.floor(size / 50) || 1));
  for (let c = 0; c < numCollections; c++) {
    collLines.push(JSON.stringify({
      id: `gid://shopify/Collection/${c + 1}`, handle: `c-${c + 1}`,
      title: `Collection ${c + 1}`, updatedAt: iso(c),
    }));
  }

  const stats = { active: 0, draft: 0, archived: 0, unpublished: 0, unavailable: 0, combinedParents: 0, combinedChildren: 0, variants: 0, collections: numCollections };
  const samples: GenResult["samples"] = { terms: [], vendors: [], types: [], typos: [], handles: [], parentGids: [], collectionGids: [] };
  for (let c = 0; c < Math.min(5, numCollections); c++) samples.collectionGids.push(`gid://shopify/Collection/${c + 1}`);

  let variantGid = 1;
  // Pre-decide combined parents: ~2% of products are parents, each followed by
  // 2–4 children (children consume product slots too). We lay them out inline.
  let i = 0;
  let pid = 0;
  while (pid < size) {
    i++;
    const n = ++pid;
    const gid = `gid://shopify/Product/${n}`;
    const adj = pick(r, ADJ); const noun = pick(r, NOUN); const type = pick(r, TYPES);
    const title = `${adj} ${type} ${noun}`;
    const vendor = pick(r, VENDORS);
    const handle = `p-${n}`;

    // visibility slices (deterministic thresholds)
    const roll = r();
    let status = "ACTIVE"; let published = true;
    if (roll < 0.05) { status = "DRAFT"; stats.draft++; }
    else if (roll < 0.08) { status = "ARCHIVED"; stats.archived++; }
    else { stats.active++; }
    if (status === "ACTIVE" && r() < 0.08) { published = false; stats.unpublished++; }

    // combined listing: become a PARENT with a few CHILD slots after it
    let combinedRole: string | null = null;
    let parentGidRef: string | null = null;
    let makeChildren = 0;
    if (status === "ACTIVE" && published && r() < 0.02 && pid + 2 <= size) {
      combinedRole = "PARENT"; stats.combinedParents++;
      makeChildren = 2 + Math.floor(r() * 3); // 2..4
      if (samples.parentGids.length < 20) samples.parentGids.push(gid);
    }

    const tags: string[] = [];
    const nTags = 2 + Math.floor(r() * 5);
    for (let t = 0; t < nTags; t++) tags.push(pick(r, TAG_POOL));

    const allUnavail = status === "ACTIVE" && published && r() < 0.10;
    if (allUnavail) stats.unavailable++;

    const nVariants = 1 + Math.floor(r() * 5);
    const node: Record<string, unknown> = {
      id: gid, handle, title,
      description: `${title} by ${vendor}. ${pick(r, ADJ)} ${pick(r, NOUN)} quality.`,
      vendor, productType: type, status,
      tags, options: [{ name: "Size", values: SIZES.slice(0, nVariants) }],
      totalInventory: allUnavail ? 0 : 1 + Math.floor(r() * 500),
      tracksInventory: true,
      featuredImage: { url: `https://cdn.shopify.com/s/files/1/0001/products/${handle}.jpg`, altText: title },
      onlineStoreUrl: published ? `https://shop.example.com/products/${handle}` : null,
      createdAt: iso(n), updatedAt: iso(n + 1),
      combinedListingRole: combinedRole,
    };
    if (r() < 0.7) node.metafields = { nodes: [{ namespace: "custom", key: "material", value: pick(r, MATERIALS) }] };
    prodLines.push(JSON.stringify(node));

    for (let v = 0; v < nVariants; v++) {
      stats.variants++;
      childLines.push(JSON.stringify({
        id: `gid://shopify/ProductVariant/${variantGid++}`, __parentId: gid,
        sku: `SKU-${n}-${v}`, price: priceOf(r), compareAtPrice: r() < 0.2 ? priceOf(r) : null,
        availableForSale: allUnavail ? false : r() > 0.1, position: v + 1,
        selectedOptions: [{ name: "Size", value: SIZES[v % SIZES.length] }], updatedAt: iso(n + 1),
      }));
    }
    // collection membership (0..3)
    const nColl = Math.floor(r() * 4);
    for (let m = 0; m < nColl; m++) {
      childLines.push(JSON.stringify({ id: `gid://shopify/Collection/${1 + Math.floor(r() * numCollections)}`, __parentId: gid }));
    }

    // samples
    if (samples.terms.length < 40) { samples.terms.push(adj.toLowerCase()); samples.terms.push(noun.toLowerCase()); }
    if (samples.vendors.length < 10 && !samples.vendors.includes(vendor)) samples.vendors.push(vendor);
    if (samples.types.length < 10 && !samples.types.includes(type)) samples.types.push(type);
    if (samples.handles.length < 30) samples.handles.push(gid);

    // emit children for a combined parent
    for (let k = 0; k < makeChildren && pid < size; k++) {
      const cn = ++pid;
      const cgid = `gid://shopify/Product/${cn}`;
      const ctitle = `${title} ${pick(r, SIZES)}`;
      stats.active++; stats.combinedChildren++;
      const cUnavail = r() < 0.1;
      const cNode: Record<string, unknown> = {
        id: cgid, handle: `p-${cn}`, title: ctitle, description: `${ctitle} variant of ${title}.`,
        vendor, productType: type, status: "ACTIVE", tags, options: [{ name: "Size", values: SIZES }],
        totalInventory: cUnavail ? 0 : 1 + Math.floor(r() * 100), tracksInventory: true,
        featuredImage: { url: `https://cdn.shopify.com/s/files/1/0001/products/p-${cn}.jpg`, altText: ctitle },
        onlineStoreUrl: `https://shop.example.com/products/p-${cn}`,
        createdAt: iso(cn), updatedAt: iso(cn + 1),
        combinedListingRole: "CHILD", combinedListing: { parentProduct: { id: gid } },
      };
      prodLines.push(JSON.stringify(cNode));
      const cnv = 1 + Math.floor(r() * 3);
      for (let v = 0; v < cnv; v++) {
        stats.variants++;
        childLines.push(JSON.stringify({
          id: `gid://shopify/ProductVariant/${variantGid++}`, __parentId: cgid,
          sku: `SKU-${cn}-${v}`, price: priceOf(r), compareAtPrice: null,
          availableForSale: cUnavail ? false : true, position: v + 1,
          selectedOptions: [{ name: "Size", value: SIZES[v % SIZES.length] }], updatedAt: iso(cn + 1),
        }));
      }
    }
  }

  // typo samples: take a real term and mangle one char deterministically
  for (const w of samples.terms.slice(0, 10)) {
    if (w.length >= 4) {
      const arr = w.split("");
      const j = 1 + (w.length % (arr.length - 2));
      const tmp = arr[j]; arr[j] = arr[j + 1]; arr[j + 1] = tmp; // transpose
      samples.typos.push(arr.join(""));
    }
  }

  return {
    productsJsonl: prodLines.concat(childLines).join("\n"),
    collectionsJsonl: collLines.join("\n"),
    productCount: prodLines.length,
    stats,
    samples,
  };
}
