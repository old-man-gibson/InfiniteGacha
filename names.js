// Names. Browser: window.Names. Node: module.exports.
//
// Two pools per race: given names, and bynames. A character is drawn a given name that nobody
// on the roster and nobody on the memorial wall is already using. Only when the race has run
// out of unused given names does anyone get a byname, so a byname carries one fact:
//
//   "Freya Ashdown" means the town already had a Freya when she arrived. A byname is not
//   decoration. Nothing branches on it, nothing rolls for it, and whoever walked in first is
//   never given one.
//
// The pools are sized so a town of a hundred rarely sees a byname at all, and a long game that
// has buried two hundred people still cannot produce two people you have to tell apart by
// their portrait. Given names run about sixty per race; crossed with bynames that is a few
// thousand per race before the last resort, which is a numeral.
//
// Bynames follow the race, because a name is the one place race shows without being stated:
// dwarves take clan names, orcs take deeds, elves take houses, androids take model revisions,
// goblins take whatever the others started calling them.

(() => {

const GIVEN = {
  human: [
    'Aldous', 'Aldric', 'Alys', 'Bertram', 'Bess', 'Brenna', 'Cassius', 'Cateline', 'Corwin',
    'Dara', 'Delia', 'Denholm', 'Edrick', 'Elian', 'Emeline', 'Ewan', 'Fendral', 'Fenna',
    'Freya', 'Garron', 'Gisla', 'Godric', 'Hale', 'Hesper', 'Hilde', 'Ines', 'Isolde', 'Ivo',
    'Jenna', 'Joris', 'Jorund', 'Kael', 'Katrin', 'Kerrin', 'Lisbet', 'Loren', 'Lucine',
    'Marek', 'Mathis', 'Merrit', 'Nella', 'Noral', 'Norwin', 'Odile', 'Orrin', 'Osric',
    'Pell', 'Perrin', 'Petra', 'Quenna', 'Quinlan', 'Radan', 'Rhoda', 'Rowena', 'Selwyn',
    'Sorcha', 'Stefan', 'Tamsin', 'Tavin', 'Thea', 'Ulric', 'Ursel', 'Verity', 'Vidar',
    'Ward', 'Willem', 'Wynne', 'Yorick', 'Ysabel',
  ],
  draconic: [
    'Akkeryx', 'Azzareth', 'Balthys', 'Brazzil', 'Cazreth', 'Cindrax', 'Ciraxis', 'Draval',
    'Dravena', 'Drexil', 'Ellazar', 'Emberyx', 'Erzhal', 'Fazhul', 'Fharos', 'Fyrrax',
    'Gharzul', 'Ghyssa', 'Hazroth', 'Hessyra', 'Irrys', 'Ithrys', 'Ixzarr', 'Jazrun',
    'Jhaleth', 'Kalzir', 'Kthara', 'Kyrrus', 'Lazhorn', 'Lyxeth', 'Mordrax', 'Morvex',
    'Nazreth', 'Nixara', 'Nyssa', 'Ophyx', 'Ormyn', 'Orzeth', 'Phyrra', 'Pyralis', 'Qazneth',
    'Quorax', 'Rhazel', 'Ruvyx', 'Sarrath', 'Sethra', 'Szeth', 'Tarrix', 'Tazhir', 'Thyrix',
    'Ulzarr', 'Uzmarr', 'Valzeth', 'Vhessa', 'Vyrax', 'Wyrmis', 'Xarreth', 'Yrgath', 'Yzareth',
    'Zhaleth', 'Zorrath',
  ],
  therian: [
    'Barrow', 'Bracken', 'Bramble', 'Bristle', 'Cinder', 'Clove', 'Coppice', 'Dapple', 'Drift',
    'Dusk', 'Elm', 'Fawn', 'Fennel', 'Fenwick', 'Fleet', 'Ghillie', 'Gorse', 'Grist', 'Harrow',
    'Hazel', 'Ilex', 'Jackdaw', 'Juniper', 'Kestrel', 'Kit', 'Lark', 'Larkspur', 'Linnet',
    'Marten', 'Mira', 'Mole', 'Moss', 'Nettle', 'Nix', 'Nutmeg', 'Osprey', 'Otter', 'Pike',
    'Plover', 'Quince', 'Reed', 'Rill', 'Rook', 'Rowan', 'Sable', 'Skitter', 'Slate', 'Sorrel',
    'Tansy', 'Thistle', 'Thorn', 'Tuli', 'Tumble', 'Vesper', 'Vetch', 'Warren', 'Whisk',
    'Willow', 'Yarrow', 'Yew',
  ],
  demonic: [
    'Abaddel', 'Azrik', 'Balgroth', 'Belphra', 'Carnith', 'Draumel', 'Dreziel', 'Ekris',
    'Emberith', 'Fauris', 'Ferrath', 'Gorvaine', 'Grimoch', 'Haldrek', 'Hexil', 'Incarra',
    'Ivress', 'Ixa', 'Jarrogh', 'Jezriel', 'Kalveth', 'Khoseth', 'Korrun', 'Lemura', 'Lilith',
    'Lurexa', 'Malzeth', 'Mordeth', 'Morganth', 'Nekhet', 'Nerath', 'Nyxareth', 'Ordrach',
    'Ossira', 'Phlegeth', 'Pyrelle', 'Quorvex', 'Rasmoth', 'Rovak', 'Sableth', 'Skarn',
    'Sorvan', 'Thessil', 'Tormach', 'Ubrek', 'Ulvira', 'Vaskoth', 'Vermil', 'Vessia', 'Wraithe',
    'Wroth', 'Xarbis', 'Xezra', 'Yrmoth', 'Yssara', 'Zaleth', 'Zorrik',
  ],
  celestial: [
    'Amariel', 'Ardiel', 'Aurel', 'Aurelian', 'Bellon', 'Benedicta', 'Cael', 'Cassiel',
    'Clarion', 'Dominel', 'Doriel', 'Elysia', 'Ephiel', 'Fanuel', 'Fidelis', 'Gabrael',
    'Gloriel', 'Halcyon', 'Haniel', 'Ianthe', 'Iriel', 'Jophiel', 'Jubilee', 'Kesiel',
    'Kyrios', 'Laudine', 'Loriel', 'Lucere', 'Lumen', 'Mirael', 'Miren', 'Muriel', 'Nathiel',
    'Novena', 'Ophiel', 'Orielle', 'Oriphiel', 'Pax', 'Peniel', 'Quiriel', 'Raziel', 'Remiel',
    'Sanctus', 'Sariel', 'Selene', 'Seraphe', 'Solane', 'Thane', 'Thurial', 'Tiberiel',
    'Ulmiel', 'Uriel', 'Vaniel', 'Veritas', 'Vespera', 'Wystan', 'Xanael', 'Yesuel', 'Yorel',
    'Ysolde', 'Zadkiel', 'Zephyr', 'Zuriel',
  ],
  android: [
    'Ampere', 'Anode', 'Axiom', 'Bit', 'Cadence', 'Cassette', 'Cipher', 'Datum', 'Delta-2',
    'Dial', 'Echo', 'Etch', 'Facet', 'Filament', 'Gauge', 'Grid', 'Halo-9', 'Helix', 'Hertz',
    'Index', 'Iris', 'Jitter', 'Junction', 'Kappa-8', 'Kelvin', 'Kilo', 'Lathe', 'Lattice',
    'Mark-4', 'Mica', 'Modem', 'Nickel', 'Node', 'Nyx-2', 'Octave', 'Ohm', 'Omega-1', 'Orin',
    'Pascal', 'Pixel', 'Quanta', 'Quartz', 'Quill', 'Relay', 'Rivet', 'Servo', 'Sigma-6',
    'Solder', 'Tessel', 'Torque', 'Trace', 'Umbra', 'Unit-3', 'Unit-7', 'Vane', 'Vector',
    'Vector-5', 'Vela', 'Wafer', 'Wick', 'Xenon', 'Yoke', 'Zenith',
  ],
  orc: [
    'Azgar', 'Bolgra', 'Bragga', 'Brug', 'Bruk', 'Chorka', 'Crushka', 'Drakka', 'Dregmar',
    'Drusha', 'Dumak', 'Ekkar', 'Ergul', 'Fangrit', 'Fargul', 'Ghorak', 'Gorrak', 'Grimma',
    'Grushka', 'Gurta', 'Halgar', 'Hokka', 'Hrogar', 'Igrun', 'Ikta', 'Jekka', 'Jorga', 'Karg',
    'Kazul', 'Korrash', 'Kruul', 'Lugra', 'Lurgash', 'Mogra', 'Morga', 'Muggat', 'Muzka',
    'Nargol', 'Nazgra', 'Ograk', 'Orbash', 'Prugg', 'Puggo', 'Ragmar', 'Rukka', 'Skarga',
    'Snagga', 'Tarrok', 'Thokk', 'Thurg', 'Tuska', 'Urgha', 'Urzog', 'Ushka', 'Ushnar',
    'Vargash', 'Vorka', 'Wurga', 'Yagra', 'Zagra', 'Zhugg', 'Zorruk', 'Zula',
  ],
  goblin: [
    'Bilge', 'Bink', 'Blot', 'Chit', 'Cog', 'Crumb', 'Dodge', 'Dribble', 'Drip', 'Eek', 'Ekk',
    'Fidget', 'Fizz', 'Flick', 'Gnash', 'Gob', 'Grizzle', 'Grub', 'Hitch', 'Hob', 'Hobble',
    'Ink', 'Itch', 'Jangle', 'Jib', 'Jot', 'Kip', 'Knack', 'Lint', 'Lug', 'Mip', 'Mox',
    'Mudge', 'Nick', 'Nim', 'Nub', 'Nudge', 'Odd', 'Ogg', 'Pib', 'Pinch', 'Prattle', 'Quibble',
    'Quirk', 'Rasp', 'Ratch', 'Scrit', 'Skiv', 'Snik', 'Splint', 'Tally', 'Tock', 'Twig',
    'Twitch', 'Ug', 'Ulp', 'Vex', 'Vim', 'Wart', 'Wisp', 'Wobble', 'Wren', 'Yark', 'Yip',
    'Zib', 'Zog',
  ],
  elf: [
    'Aelar', 'Aenwyn', 'Aerin', 'Anwyn', 'Belarion', 'Brialle', 'Caelum', 'Ceridwen', 'Cirian',
    'Daenil', 'Daeryn', 'Eirlys', 'Elowen', 'Erenya', 'Faelar', 'Faenor', 'Fenwyn', 'Galanor',
    'Gwendal', 'Haleth', 'Hyalen', 'Ilyana', 'Ithelia', 'Jaelith', 'Jorlan', 'Kaelin',
    'Kethryn', 'Lathriel', 'Liriel', 'Lirien', 'Maelis', 'Myrial', 'Naerys', 'Nimue', 'Nolwen',
    'Ondriel', 'Oriath', 'Perion', 'Phaeryn', 'Quessir', 'Rhoswen', 'Rielle', 'Saelith',
    'Sylvarin', 'Sylvi', 'Taeryn', 'Thalion', 'Thessaly', 'Ulwyn', 'Ulyria', 'Vaelin', 'Vaeril',
    'Wyndel', 'Xaeria', 'Yllaria', 'Yssaline', 'Zyrian',
  ],
  darkelf: [
    'Ashkyra', 'Aszan', 'Belvyr', 'Brytha', 'Chalyx', 'Crynn', 'Dessina', 'Drizzen', 'Dyvara',
    'Elqar', 'Erdryn', 'Faerith', 'Fyrnn', 'Ghaunad', 'Grethyl', 'Hazzryn', 'Hlaan', 'Ilvara',
    'Innyrl', 'Ivrath', 'Jhaelen', 'Jherek', 'Kelvyr', 'Kyorvin', 'Luvenne', 'Lythra', 'Malrik',
    'Mordryn', 'Myrkith', 'Nathyra', 'Nyxen', 'Orvyr', 'Ozryn', 'Pellyx', 'Phaerl', 'Quenvyr',
    'Rhyzel', 'Rizzen', 'Ryldar', 'Sablyn', 'Sszara', 'Thraxa', 'Tsarra', 'Ulvyr', 'Umbryn',
    'Vaerith', 'Vexryn', 'Vhalyr', 'Wraeth', 'Xandryl', 'Xilvara', 'Xune', 'Yasra', 'Yrthax',
    'Zaknir', 'Zesstra', 'Zhaerin',
  ],
  dwarf: [
    'Alva', 'Astrid', 'Balin', 'Bersi', 'Brokk', 'Bruni', 'Dagny', 'Dagrun', 'Durin', 'Dvalin',
    'Eirik', 'Eldgrim', 'Eystein', 'Fastvi', 'Fjolnir', 'Frodi', 'Gerd', 'Grimnir', 'Gunnar',
    'Gunnhild', 'Hallr', 'Hallveig', 'Hjalmar', 'Idunn', 'Ingrid', 'Ivar', 'Jarnvid', 'Jokul',
    'Jorunn', 'Kari', 'Ketil', 'Kolbrun', 'Leifr', 'Lofn', 'Ludda', 'Magni', 'Motsa', 'Mundi',
    'Nal', 'Nanna', 'Njal', 'Onund', 'Orm', 'Ottar', 'Ragna', 'Ragnhild', 'Runa', 'Sigrun',
    'Sindri', 'Skafid', 'Steinar', 'Thora', 'Thrand', 'Torvald', 'Tova', 'Ulfrun', 'Uni',
    'Vali', 'Vestri', 'Vigdis', 'Ylva', 'Yngvar',
  ],
  halfgiant: [
    'Ake', 'Arn', 'Aslaug', 'Bolvar', 'Borg', 'Bothvar', 'Brunhild', 'Carsten', 'Dagfin',
    'Drengr', 'Drott', 'Eberhard', 'Egil', 'Erlend', 'Folke', 'Frida', 'Frosti', 'Geir',
    'Gorm', 'Grimar', 'Gudrun', 'Halvor', 'Haraldr', 'Hessa', 'Hrolf', 'Ingvar', 'Isolf',
    'Jorvi', 'Jotta', 'Ketla', 'Knut', 'Kolgrim', 'Larka', 'Leiv', 'Ludvar', 'Magda', 'Mjoll',
    'Modolf', 'Mundr', 'Njord', 'Nokk', 'Nordri', 'Onar', 'Orla', 'Ottokar', 'Palvi', 'Ragnar',
    'Ragnvald', 'Rurik', 'Sigvard', 'Solveig', 'Sten', 'Thurid', 'Tofa', 'Tor', 'Torgny',
    'Ubbe', 'Ulf', 'Unnr', 'Valka', 'Vidkun', 'Vigga', 'Wenda', 'Wulfstan', 'Ylle', 'Ymir',
    'Yrsa',
  ],
};

// What the second one of you gets called. Same shape everywhere — one word after the given
// name — but the register follows the race.
const BYNAMES = {
  human: ['Ashdown', 'Barrowe', 'Blackwood', 'Bramwell', 'Carrick', 'Chandler', 'Coldwell',
    'Deering', 'Fenn', 'Gallow', 'Hartley', 'Holloway', 'Ironside', 'Kettering', 'Lambert',
    'Marrow', 'Mereworth', 'Netherby', 'Oakes', 'Pryor', 'Quarles', 'Raddock', 'Sedgewick',
    'Stanhope', 'Thatcher', 'Underhill', 'Vance', 'Walcott', 'Weatherby', 'Whitlock'],
  draconic: ['Ashwing', 'Bonecoil', 'Cindertongue', 'Duskscale', 'Emberscale', 'Flamehoard',
    'Gildclaw', 'Hoardkeeper', 'Ironmaw', 'Kilnborn', 'Longcoil', 'Moltenwing', 'Nightscale',
    'Oathfire', 'Pyreborn', 'Ruinwing', 'Scorchmaw', 'Sootbrood', 'Stormgullet', 'Sunhoard',
    'Thornscale', 'Tidecoil', 'Vaultbrood', 'Wyrmtongue'],
  therian: ['Backpaw', 'Briarfoot', 'Burrowick', 'Cloudchaser', 'Dewclaw', 'Fernback',
    'Gladefoot', 'Hollowtail', 'Longwhisker', 'Mudpelt', 'Nightnose', 'Quickfoot', 'Rainpelt',
    'Ratcatcher', 'Redtail', 'Riverstep', 'Softpad', 'Splitear', 'Stonelick', 'Thornpelt',
    'Twiceborn', 'Underbrush', 'Windfur', 'Woodsedge'],
  demonic: ['Ashmouth', 'Blackvow', 'Bloodpact', 'Bonewrit', 'Chainbitten', 'Coldsigil',
    'Debtkeeper', 'Emberchain', 'Firstoath', 'Gravebound', 'Hellwrit', 'Ironvow', 'Lastname',
    'Nightbargain', 'Pactborn', 'Ruinsworn', 'Saltless', 'Sinbrand', 'Smokeoath', 'Soulcount',
    'Thricebound', 'Unransomed', 'Vowbreaker', 'Wormtithe'],
  celestial: ['Brightkept', 'Candlewake', 'Dawnsung', 'Duskvigil', 'Firstlight', 'Goldhymn',
    'Haloworn', 'Highsong', 'Hourkeeper', 'Lampbearer', 'Lastvigil', 'Mercykept', 'Ninthchoir',
    'Noonward', 'Pealbright', 'Psalmwrit', 'Quietmatins', 'Starkept', 'Sunwake', 'Trumpetborn',
    'Vesperkept', 'Watchward', 'Whitehymn'],
  android: ['Mk II', 'Mk III', 'Mk IV', 'Mk V', 'Rev B', 'Rev C', 'Rev D', 'Series 2',
    'Series 3', 'Chromeplate', 'Coldstart', 'Deadlock', 'Failsafe', 'Hotswap', 'Longrun',
    'Nought', 'Overclock', 'Reissue', 'Salvaged', 'Secondhand', 'Shortcircuit', 'Spare',
    'Warmboot', 'Wornbearing'],
  orc: ['Axebit', 'Blackbanner', 'Bonecrack', 'Camptaker', 'Doubletusk', 'Fangbroke',
    'Gutcarver', 'Hillroarer', 'Ironjaw', 'Longspear', 'Mudwader', 'Nineteeth', 'Oathshout',
    'Ridgeburner', 'Scarhand', 'Shieldeater', 'Skullsplit', 'Stoneknuckle', 'Thricecut',
    'Warhowl', 'Wolfrider', 'Wounddrinker'],
  goblin: ['Bentnose', 'Bigger', 'Bootstealer', 'Cheapskate', 'Crumbfinger', 'Ditchwater',
    'Fingersticky', 'Halfear', 'Handmedown', 'Lastpicked', 'Loudmouth', 'Nofriend',
    'Notthatone', 'Pocket', 'Ratbiter', 'Runnyeye', 'Secondhelping', 'Shortstraw', 'Sneakabout',
    'Spareparts', 'Twoteeth', 'Wormeater'],
  elf: ['Aelthorn', 'Ashenbough', 'Duskmere', 'Eventhorn', 'Fairholt', 'Glimmerfen',
    'Greenmantle', 'Halewood', 'Lorenhal', 'Moonhollow', 'Mournbough', 'Nightleaf',
    'Oakenshade', 'Palewillow', 'Quietvale', 'Ravenmere', 'Silverbough', 'Starfallow',
    'Sunmarch', 'Thornwild', 'Winterbloom', 'Yewmantle'],
  darkelf: ['Ashveil', 'Blindlantern', 'Coldwarren', 'Deepbind', 'Dustcrown', 'Gloomspire',
    'Grudgeholt', 'Hushblade', 'Ironweb', 'Knifekept', 'Lampless', 'Nightspire', 'Poisonhall',
    'Quietfang', 'Saltwarden', 'Shalefall', 'Silkgarrote', 'Spiderhearth', 'Stillwater',
    'Underwrit', 'Vaultless', 'Webbind'],
  dwarf: ['Anvilkin', 'Ashforge', 'Blackvein', 'Bootnail', 'Copperbraid', 'Deepvein',
    'Emberhand', 'Firstseam', 'Gravelbeard', 'Hammerfast', 'Ironbrow', 'Ledgerkeep',
    'Longdelve', 'Oldshaft', 'Orebound', 'Quarrykin', 'Runeknuckle', 'Saltcut', 'Slagborn',
    'Stonebeard', 'Tunnelwise', 'Underhelm'],
  halfgiant: ['Bouldershoulder', 'Bridgebreak', 'Cairnbuilder', 'Cliffbraced', 'Doorducker',
    'Fellwalker', 'Hillbreaker', 'Hollowvoice', 'Longstride', 'Millstone', 'Oxcarry',
    'Pinepuller', 'Ridgeborn', 'Roofscraper', 'Slowthunder', 'Snowwader', 'Stormshoulder',
    'Thawlate', 'Treefeller', 'Winterfast'],
};

const R = () => (typeof Rng !== 'undefined') ? Rng : require('./rng.js');

const RACES = Object.keys(GIVEN);
const givenPool = (race) => GIVEN[race] || GIVEN.human;
const bynamePool = (race) => BYNAMES[race] || BYNAMES.human;

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];
/** Small roman numerals, then plain digits. Only the very last resort ever reaches this. */
function numeral(n) { return n < ROMAN.length ? ROMAN[n] : String(n); }

/**
 * Every name currently spoken for: the roster, the memorial wall, and anyone who was absorbed
 * into somebody else. The dead keep their names — a new arrival called Freya while the wall
 * already reads Freya is exactly the confusion this module exists to prevent.
 */
function inUse(state) {
  const taken = new Set();
  const add = (n) => { if (n) taken.add(n); };
  for (const c of (state.characters || [])) {
    add(c.name);
    for (const a of (c.absorbed || [])) add(a.name);
  }
  for (const f of ((state.roster && state.roster.fallen) || [])) add(f.name);
  return taken;
}

/**
 * A name for a new arrival of this race that nobody in `taken` is using. Given name alone if
 * the race has one spare; otherwise a given name plus a byname; otherwise a numeral, which
 * cannot run out.
 */
function pick(race, taken) {
  const has = (n) => !!(taken && (taken.has ? taken.has(n) : taken.indexOf(n) >= 0));
  const given = givenPool(race);
  const free = given.filter(n => !has(n));
  if (free.length) return R().pick(free);

  const bynames = bynamePool(race);
  for (const g of R().shuffle(given.slice())) {
    const spare = bynames.filter(b => !has(g + ' ' + b));
    if (spare.length) return g + ' ' + R().pick(spare);
  }
  const g = R().pick(given);
  for (let n = 2; ; n++) { const name = g + ' ' + numeral(n); if (!has(name)) return name; }
}

/** pick(), reading the taken set off the save. */
function pickFor(state, race) { return pick(race, inUse(state)); }

/**
 * One-off repair for saves written when names were drawn without looking at who was already
 * standing there. The earliest arrival keeps the bare name; everyone after them earns the
 * byname they should have been handed at the gate. Returns [{ id, from, to }].
 */
function dedupe(state) {
  const seen = new Set();
  for (const f of ((state.roster && state.roster.fallen) || [])) if (f.name) seen.add(f.name);
  const changed = [];
  const order = (state.characters || []).slice()
    .sort((a, b) => (a.obtained || 0) - (b.obtained || 0) || (a.id || 0) - (b.id || 0));
  for (const c of order) {
    if (!c.name) { c.name = pick(c.race, seen); seen.add(c.name); continue; }
    if (!seen.has(c.name)) { seen.add(c.name); continue; }
    const from = c.name;
    // They keep the name they answer to. Only the byname is new.
    const spare = bynamePool(c.race).filter(b => !seen.has(from + ' ' + b));
    c.name = spare.length ? from + ' ' + R().pick(spare) : pick(c.race, seen);
    seen.add(c.name);
    changed.push({ id: c.id, from, to: c.name });
  }
  return changed;
}

/** How many distinct names a race can produce before it has to start counting. */
function capacity(race) { return givenPool(race).length * (1 + bynamePool(race).length); }

const NamesAPI = { GIVEN, BYNAMES, RACES, pick, pickFor, inUse, dedupe, capacity, numeral };
if (typeof module !== 'undefined') module.exports = NamesAPI;
if (typeof window !== 'undefined') window.Names = NamesAPI;
})();
