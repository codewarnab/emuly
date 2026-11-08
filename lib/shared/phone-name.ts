/** Friendly phone names look like `phone-quiet-falcon`. Internal ids for older
    phones stay as they were, and this maps them to the same shape for display. */
const ADJECTIVES = [
  "amber", "azure", "bold", "brave", "bright", "bronze", "calm", "clever",
  "cobalt", "copper", "coral", "cosmic", "crimson", "crystal", "dapper", "daring",
  "eager", "fancy", "frosty", "gentle", "glowing", "golden", "happy", "indigo",
  "ivory", "jade", "jolly", "lucky", "mellow", "misty", "nimble", "olive",
  "polar", "quiet", "rapid", "rosy", "ruby", "rustic", "sandy", "silver",
  "sunny", "swift", "teal", "tidy", "velvet", "vivid", "wild", "zesty",
];

const NOUNS = [
  "badger", "beaver", "bison", "caribou", "cheetah", "cobra", "condor", "crane",
  "dingo", "dolphin", "eagle", "egret", "falcon", "ferret", "finch", "fox",
  "gazelle", "gecko", "heron", "ibis", "jaguar", "koala", "lemur", "lynx",
  "mantis", "marlin", "narwhal", "orca", "osprey", "otter", "panda", "panther",
  "puffin", "quokka", "raven", "robin", "salamander", "seal", "sparrow", "tern",
  "tiger", "toucan", "viper", "walrus", "whale", "wombat", "yak", "zebra",
];

const FRIENDLY = /^phone-[a-z]+-[a-z]+$/;

/** Every id the app accepts, including hex ids created before friendly names. */
export const PHONE_ID = /^phone-(?:[a-f0-9]{4,32}|[a-z]+-[a-z]+)$/;

function pair(hash: number): string {
  const adjective = ADJECTIVES[hash % ADJECTIVES.length]!;
  const noun = NOUNS[Math.floor(hash / ADJECTIVES.length) % NOUNS.length]!;
  return `phone-${adjective}-${noun}`;
}

/** A stable name for any phone id. Friendly ids are returned unchanged. */
export function phoneName(id: string): string {
  if (FRIENDLY.test(id)) return id;
  // FNV-1a keeps the name stable across restarts, servers and deployments.
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return pair(hash);
}

/** A random candidate for a new phone id. The caller checks that it is unused. */
export function candidatePhoneName(random: number): string {
  return pair(random >>> 0);
}
