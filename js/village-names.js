// Village names: 200 real New Zealand towns (North Island first, then South Island). Picked per village by js/signs.js
// (BF.signs.villageName); deterministic from the world seed and the village's region, no repeats among nearby villages.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
BF.VILLAGE_NAMES = Object.freeze([
  "Kaitaia", "Kerikeri", "Kaikohe", "Paihia", "Russell", "Kawakawa", "Moerewa", "Whangārei", "Dargaville", "Ruakākā",
  "Waipu", "Mangawhai", "Wellsford", "Warkworth", "Helensville", "Pukekohe", "Waiuku", "Tuakau", "Pōkeno", "Huntly",
  "Ngāruawāhia", "Raglan", "Hamilton", "Cambridge", "Te Awamutu", "Ōtorohanga", "Te Kūiti", "Matamata", "Morrinsville",
  "Te Aroha", "Paeroa", "Waihī", "Thames", "Coromandel", "Whitianga", "Tairua", "Whangamatā", "Katikati", "Tauranga",
  "Te Puke", "Rotorua", "Taupō", "Tūrangi", "Tokoroa", "Putāruru", "Murupara", "Kawerau", "Whakatāne", "Ōpōtiki",
  "Edgecumbe", "Gisborne", "Tolaga Bay", "Ruatōria", "Tokomaru Bay", "Wairoa", "Napier", "Hastings", "Havelock North",
  "Waipawa", "Waipukurau", "Dannevirke", "Woodville", "Pahiatua", "Eketāhuna", "Masterton", "Carterton", "Greytown",
  "Featherston", "Martinborough", "Porirua", "Paraparaumu", "Waikanae", "Ōtaki", "Levin", "Foxton", "Shannon",
  "Feilding", "Palmerston North", "Ashhurst", "Marton", "Bulls", "Hunterville", "Taihape", "Waiōuru", "Ohakune",
  "Raetihi", "Taumarunui", "Whanganui", "Waverley", "Pātea", "Hāwera", "Eltham", "Stratford", "Inglewood",
  "New Plymouth", "Waitara", "Ōpunake", "Manaia", "Ōkato", "Te Kauwhata", "Ngatea", "Tīrau", "Mangakino", "Reporoa",
  "Ōhope", "Mount Maunganui", "Waihī Beach", "Ōmokoroa", "Kaiwaka", "Maungaturoto", "Ruawai", "Kohukohu", "Rāwene",
  "Ōmāpere", "Mangonui", "Ahipara", "Hikurangi", "Te Kōpuru", "Nelson", "Richmond", "Motueka", "Tākaka", "Collingwood",
  "Murchison", "Blenheim", "Picton", "Havelock", "Renwick", "Seddon", "Kaikōura", "Hanmer Springs", "Cheviot",
  "Culverden", "Amberley", "Rangiora", "Kaiapoi", "Oxford", "Darfield", "Rolleston", "Lincoln", "Leeston", "Akaroa",
  "Methven", "Ashburton", "Rakaia", "Geraldine", "Temuka", "Timaru", "Pleasant Point", "Fairlie", "Tekapo", "Twizel",
  "Ōmarama", "Kurow", "Waimate", "Ōamaru", "Palmerston", "Waikouaiti", "Mosgiel", "Milton", "Balclutha", "Kaitangata",
  "Owaka", "Lawrence", "Roxburgh", "Alexandra", "Clyde", "Cromwell", "Wānaka", "Queenstown", "Arrowtown", "Ranfurly",
  "Naseby", "Te Anau", "Manapōuri", "Tuatapere", "Riverton", "Ōtautau", "Winton", "Lumsden", "Mossburn", "Gore",
  "Mataura", "Wyndham", "Invercargill", "Bluff", "Westport", "Reefton", "Greymouth", "Hokitika", "Ross", "Harihari",
  "Franz Josef", "Fox Glacier", "Haast", "Karamea", "Runanga", "Brightwater", "Wakefield", "Ōpononi"
]);
})();
