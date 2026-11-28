// Priority lists for Forever One Button, the owner's other addon, which can
// import such a list as a "rotation profile". The AI writes one list per kind
// of fight ("oneButton" in the model); without one, the best candidate of that
// fight stands in. Either way this code cleans the list into what One Button
// can play, says in plain sentences what it could not carry over, and the
// simulator measures exactly the cleaned list (oneButtonFor below).
//
// The target format is One Button's (ForeverOneButton/Core/Profiles.lua,
// SCHEMA and the limits): entries { id, gates } where each gate is a condition
// type ("t") with a few fields. One Button already holds an entry back while
// its spell is unknown, unusable, short of resources, on cooldown, out of
// range, or a DoT it knows is still ticking (Engine/Queue.lua Evaluate), so
// none of that needs a gate. A gate it cannot answer never holds an ability
// back, so a condition lost on the way makes an ability come up more freely
// than the model meant: that is what the rules below guard against.
//
// Every gate comes with the condition it stands for in the model's own
// language ("conds"), so the cleaned list can be simulated as One Button
// would play it: a condition left out is left out of both, and one carried
// over only roughly is simulated the rough way.
import { num, str, text } from './json.js';

export const ONE_BUTTON_VERSION = 1;
const MAX_ENTRIES = 60;   // per list
const MAX_GATES = 12;     // per entry and per group
const MAX_DEPTH = 3;      // an entry's own gates are depth 1; groups nest up to here
const MAX_LEFT = 8;
const LEFT_LEN = 160;
const NAME_LEN = 80;

// The number ranges of One Button's SCHEMA, for the fields emitted here. A
// gate with a value outside them would be dropped by its sanitizer, so it is
// left out here instead, with a line saying so.
const RANGES = {
  power: { n: [-100000, 100000] },
  buff: { dur: [0, 86400] },
  stack: { n: [0, 1000] },
  targets: { n: [0, 100] },
  execute: { pct: [0, 100] },
  resource: { n: [0, 10] },
  swing: { n: [0, 10] },
};
const SPELL_MAX = 2147483648;
const spellId = (v) => {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n > 0 && n < SPELL_MAX ? n : null;
};
function inRange(gate) {
  for (const [field, [low, high]] of Object.entries(RANGES[gate.t] || {})) {
    if (field in gate && !(gate[field] >= low && gate[field] <= high)) return false;
  }
  return true;
}

// The spells One Button keeps track of as DoTs by itself (Dots.Active in
// Engine/Dots.lua): every rank whose base rank is in Data/Defaults.lua
// targetDots, ranks taken from Data/Rotations.lua rankChains, Forever One
// Button 1.1.4-zm9 (153 ids). It holds such a spell back while its DoT is up
// on the target. A spell named by any target stack gate stops being treated
// as a DoT there, so no stack gate is ever emitted for one of these.
const TRACKED_DOTS = new Set([
  99, 172, 339, 348, 589, 594, 603, 703, 707, 770, 772, 778, 970, 980, 992, 1014, 1062, 1079, 1094, 1120,
  1130, 1160, 1735, 1822, 1823, 1824, 1943, 1978, 2767, 2941, 3674, 5195, 5196, 5570, 6190, 6217, 6222, 6223,
  6546, 6547, 6548, 7648, 8050, 8052, 8053, 8288, 8289, 8631, 8632, 8633, 8639, 8640, 8921, 8924, 8925, 8926,
  8927, 8928, 8929, 9490, 9492, 9493, 9747, 9749, 9752, 9833, 9834, 9835, 9852, 9853, 9894, 9896, 9898, 9904,
  9907, 10447, 10448, 10797, 10892, 10893, 10894, 11273, 11274, 11275, 11289, 11290, 11554, 11555, 11556,
  11572, 11573, 11574, 11665, 11667, 11668, 11671, 11672, 11675, 11711, 11712, 11713, 13549, 13550, 13551,
  13552, 13553, 13554, 13555, 13797, 14296, 14298, 14299, 14300, 14301, 14323, 14324, 14325, 15407, 17311,
  17312, 17313, 17314, 18265, 18807, 18879, 18880, 18881, 19296, 19299, 19302, 19303, 19304, 19305, 24118,
  24119, 24120, 24974, 24975, 24976, 24977, 25295, 25309, 25311, 29228, 414644, 440892, 1235826, 1235827,
  1299332, 1311676, 1311677, 1311680, 1316697
]);
// One Button counts an effect it does not track from the player's own
// casts, one application per cast lasting this long (Dots.DEFAULT_STACKING).
const COUNTED_SECONDS = 30;

// Every other rank of a spell with its rank-1 id, from Data/Rotations.lua
// rankChains, Forever One Button 1.1.4-zm9 (1455 ids), as { rank-1 id: [the
// other ranks] }. One Button counts the player's casts on a target under the
// spell's rank-1 id (Ranks.Base in Engine/Dots.lua), but it picks the spells
// to count by the id written in a target stack gate, so a gate that names
// another rank counts nothing. Only those gates take the rank-1 id: every
// other gate and the entries work with any rank and keep the character's own.
const RANK_CHAINS = {
  10: [6141, 8427, 10185, 10186, 10187], 17: [592, 600, 3747, 6065, 6066, 10898, 10899, 10900, 10901],
  53: [2589, 2590, 2591, 8721, 11279, 11280, 11281, 25300], 67: [9452], 72: [1671, 1672],
  78: [284, 285, 1608, 11564, 11565, 11566, 11567, 25286], 99: [1735, 9490, 9747, 9898], 100: [6178, 11578],
  116: [205, 837, 7322, 8406, 8407, 8408, 10179, 10180, 10181, 25304],
  118: [12824, 12825, 12826, 28271, 28272], 120: [8492, 10159, 10160, 10161], 122: [865, 6131, 10230],
  132: [2970, 11743], 133: [143, 145, 3140, 8400, 8401, 8402, 10148, 10149, 10150, 10151, 25306],
  136: [3111, 3661, 3662, 13542, 13543, 13544],
  139: [6074, 6075, 6076, 6077, 6078, 10927, 10928, 10929, 25315], 168: [7300, 7301],
  172: [6222, 6223, 7648, 11671, 11672, 25311],
  324: [325, 905, 945, 8134, 10431, 10432, 26363, 26364, 26365, 26366, 26367, 26369, 26370],
  331: [332, 547, 913, 939, 959, 8005, 10395, 10396, 25357], 339: [1062, 5195, 5196, 9852, 9853],
  348: [707, 1094, 2941, 11665, 11667, 11668, 25309], 370: [8012],
  403: [529, 548, 915, 943, 6041, 10391, 10392, 15207, 15208], 408: [8643], 421: [930, 2860, 10605],
  453: [8192, 10953], 465: [643, 1032, 10290, 10291, 10292, 10293], 467: [782, 1075, 8914, 9756, 9910],
  468: [16083], 471: [16082], 498: [5573], 527: [988], 543: [8457, 8458, 10223, 10225], 579: [16080],
  585: [591, 598, 984, 1004, 6060, 10933, 10934], 586: [9578, 9579, 9592, 10941, 10942],
  587: [597, 990, 6129, 10144, 10145, 28612], 588: [602, 1006, 7128, 10951, 10952],
  589: [594, 970, 992, 2767, 10892, 10893, 10894], 596: [996, 10960, 10961, 25316],
  604: [8450, 8451, 10173, 10174], 605: [10911, 10912], 633: [2800, 10310],
  635: [639, 647, 1026, 1042, 3472, 10328, 10329, 25292], 642: [1020],
  679: [678, 680, 1866, 2495, 5569, 10332, 10333],
  686: [695, 705, 1088, 1106, 7641, 11659, 11660, 11661, 25307], 687: [696],
  689: [699, 709, 7651, 11699, 11700], 693: [20752, 20755, 20756, 20757], 694: [7400, 7402, 20559, 20560],
  702: [1108, 6205, 7646, 11707, 11708], 703: [8631, 8632, 8633, 11289, 11290], 704: [7658, 7659, 11717],
  706: [1086, 11733, 11734, 11735], 710: [18647], 724: [27870, 27871], 740: [8918, 9862, 9863],
  755: [3698, 3699, 3700, 11693, 11694, 11695], 770: [778, 9749, 9907],
  772: [6546, 6547, 6548, 11572, 11573, 11574],
  774: [1058, 1430, 2090, 2091, 3627, 8910, 9839, 9840, 9841, 25299], 779: [769, 780, 9754, 9908],
  781: [14272, 14273], 845: [7369, 11608, 11609, 20569], 853: [5588, 5589, 10308],
  879: [5614, 5615, 10312, 10313, 10314], 976: [10957, 10958], 980: [1014, 6217, 11711, 11712, 11713],
  1008: [8455, 10169, 10170], 1022: [5599, 10278], 1064: [10622, 10623], 1079: [9492, 9493, 9752, 9894, 9896],
  1082: [3029, 5201, 9849, 9850], 1098: [11725, 11726], 1120: [8288, 8289, 11675],
  1126: [5232, 5234, 6756, 8907, 9884, 9885], 1130: [14323, 14324, 14325], 1160: [6190, 11554, 11555, 11556],
  1243: [1244, 1245, 2791, 10937, 10938], 1449: [8437, 8438, 8439, 10201, 10202],
  1454: [1455, 1456, 11687, 11688, 11689], 1459: [1460, 1461, 10156, 10157],
  1463: [8494, 8495, 10191, 10192, 10193], 1495: [14269, 14270, 14271], 1499: [14310, 14311],
  1510: [14294, 14295], 1513: [14326, 14327], 1515: [13481, 13535], 1714: [11719], 1715: [7372, 7373],
  1742: [1747, 1748, 1749, 1750, 1751, 1753, 1754, 1755, 1756, 16697, 16698],
  1752: [1757, 1758, 1759, 1760, 8621, 11293, 11294], 1766: [1767, 1768, 1769],
  1776: [1777, 8629, 11285, 11286], 1784: [1785, 1786, 1787], 1822: [1823, 1824, 9904], 1850: [9821],
  1853: [2649, 14916, 14917, 14918, 14919, 14920, 14921, 14922, 14923, 14924, 14925, 14926, 14927],
  1856: [1857], 1943: [8639, 8640, 11273, 11274, 11275], 1949: [11683, 11684],
  1966: [6768, 8637, 11303, 25302], 1978: [13549, 13550, 13551, 13552, 13553, 13554, 13555, 25295],
  2006: [2010, 10880, 10881, 20770], 2008: [20609, 20610, 20776, 20777], 2050: [2052, 2053],
  2054: [2055, 6063, 6064], 2060: [10963, 10964, 10965, 25314], 2061: [9472, 9473, 9474, 10915, 10916, 10917],
  2096: [10909], 2098: [6760, 6761, 6762, 8623, 8624, 11299, 11300, 31016],
  2120: [2121, 8422, 8423, 10215, 10216], 2136: [2137, 2138, 8412, 8413, 10197, 10199], 2362: [17727, 17728],
  2382: [9125], 2637: [18657, 18658],
  2652: [2943, 19249, 19251, 19252, 19253, 19254, 19261, 19262, 19264, 19265, 19266], 2812: [10318],
  2878: [5627, 10326], 2908: [8955, 9901], 2912: [8949, 8950, 8951, 9875, 9876, 25298],
  2944: [19276, 19277, 19278, 19279, 19280], 2948: [8444, 8445, 8446, 10205, 10206, 10207],
  2973: [14260, 14261, 14262, 14263, 14264, 14265, 14266], 2974: [14267, 14268],
  2975: [2976, 2977, 2980, 2981, 2982, 3666, 3667], 2983: [8696, 11305], 3034: [14279, 14280],
  3044: [14281, 14282, 14283, 14284, 14285, 14286, 14287], 3365: [6247, 6477, 6478, 21651],
  3599: [6363, 6364, 6365, 10437, 10438], 3674: [14296],
  4187: [4188, 4189, 4190, 4191, 4192, 4193, 4194, 4195, 4196, 4197, 4198, 4199, 4200, 4201, 4202, 5041, 5042, 5048, 5049],
  5138: [6226, 11703, 11704], 5143: [5144, 5145, 8416, 8417, 10211, 10212, 25345], 5171: [6774],
  5176: [5177, 5178, 5179, 5180, 6780, 8905, 9912],
  5185: [5186, 5187, 5188, 5189, 6778, 8903, 9758, 9888, 9889, 25297], 5211: [6798, 8983], 5215: [6783, 9913],
  5221: [6800, 8992, 9829, 9830], 5308: [20658, 20660, 20661, 20662], 5394: [6375, 6377, 10462, 10463],
  5484: [17928], 5570: [24974, 24975, 24976, 24977], 5675: [10495, 10496, 10497],
  5676: [17919, 17920, 17921, 17922, 17923], 5730: [6390, 6391, 6392, 10427, 10428],
  5740: [6219, 11677, 11678], 5782: [6213, 6215], 6117: [22782, 22783], 6143: [8461, 8462, 10177, 28609],
  6201: [5699, 6202, 11729, 11730], 6229: [11739, 11740, 28610], 6233: [6246, 21652],
  6281: [6280, 6282, 6283, 6286], 6311: [6314, 6315, 6316, 6317], 6328: [6331, 6332, 6333, 6334],
  6343: [8198, 8204, 8205, 11580, 11581], 6353: [17924], 6366: [17951, 17952, 17953],
  6443: [6444, 6445, 6446, 6447], 6552: [6554], 6572: [6574, 7379, 11600, 11601, 25288],
  6673: [5242, 6192, 11549, 11550, 11551, 25289], 6770: [2070, 11297], 6785: [6787, 9866, 9867],
  6789: [17925, 17926], 6807: [6808, 6809, 8972, 9745, 9880, 9881], 6896: [17461], 6940: [20729],
  7001: [27873, 27874], 7294: [10298, 10299, 10300, 10301], 7302: [7320, 10219, 10220],
  7328: [10322, 10324, 20772, 20773], 7370: [26184, 26185, 26186, 26202, 28343], 7384: [7887, 11584, 11585],
  7386: [7405, 8380, 11596, 11597], 8004: [8008, 8010, 10466, 10467, 10468],
  8017: [8018, 8019, 10399, 16314, 16315, 16316], 8024: [8027, 8030, 16339, 16341, 16342],
  8033: [8038, 10456, 16355, 16356], 8042: [8044, 8045, 8046, 10412, 10413, 10414],
  8050: [8052, 8053, 10447, 10448, 29228], 8056: [8058, 10472, 10473], 8071: [8154, 8155, 10406, 10407, 10408],
  8075: [8160, 8161, 10442, 25361], 8092: [8102, 8103, 8104, 8105, 8106, 10945, 10946, 10947],
  8122: [8124, 10888, 10890], 8129: [8131, 10874, 10875, 10876], 8181: [10478, 10479], 8184: [10537, 10538],
  8190: [10585, 10586, 10587], 8227: [8249, 10526, 16387], 8232: [8235, 10486, 16362], 8512: [10613, 10614],
  8647: [8649, 8650, 11197, 11198], 8676: [8724, 8725, 11267, 11268, 11269], 8835: [10627, 25359],
  8921: [8924, 8925, 8926, 8927, 8928, 8929, 9833, 9834, 9835],
  8936: [8938, 8939, 8940, 8941, 9750, 9856, 9857, 9858], 8998: [9000, 9892], 9005: [9823, 9827],
  9035: [19281, 19282, 19283, 19284, 19285], 9484: [9485, 10955], 10595: [10600, 10601],
  10795: [17450, 436289], 10797: [19296, 19299, 19302, 19303, 19304, 19305], 11071: [12494], 11103: [12355],
  11113: [13018, 13019, 13020, 13021], 11366: [12505, 12522, 12523, 12524, 12525, 12526, 18809],
  11426: [13031, 13032, 13033], 12281: [12284, 12700], 12288: [12707, 12708], 12290: [12963],
  12294: [21551, 21552, 21553], 12302: [12765], 12307: [12944, 12945], 12318: [12857, 12858, 12860, 12861],
  12322: [12964], 12324: [12876, 12877, 12878, 12879], 12327: [12886], 13161: [1299445, 1299446, 1299447],
  13165: [14318, 14319, 14320, 14321, 14322, 25296], 13707: [13966, 13967, 13968, 13969],
  13709: [13706, 13960], 13795: [14302, 14303, 14304, 14305], 13797: [14298, 14299, 14300, 14301],
  13812: [14314, 14315], 13813: [14316, 14317], 13819: [1279399], 13896: [19271, 19273, 19274, 19275],
  13908: [19236, 19238, 19240, 19241, 19242, 19243], 13976: [13977], 14076: [14094, 14095], 14749: [14767],
  14752: [14818, 14819, 27841], 14914: [15261, 15262, 15263, 15264, 15265, 15266, 15267],
  15107: [15111, 15112], 15237: [15430, 15431, 23455, 23458, 23459, 27799, 27800, 27801, 27803, 27804, 27805],
  15268: [15323, 15324, 15325, 15326], 15407: [17311, 17312, 17313, 17314, 18807], 15780: [17453],
  16060: [436329, 463006], 16180: [16196, 16198], 16190: [17354, 17359], 16253: [16298, 16299, 16300, 16301],
  16259: [16295], 16579: [16580, 16581, 16582], 16689: [16810, 16811, 16812, 16813, 17329],
  16836: [16839, 16840], 16858: [16859, 16860, 16861, 16862], 16902: [16903, 16904, 16905, 16906],
  16914: [17401, 17402], 17050: [17051, 17053, 17054, 17055], 17079: [17082],
  17254: [17262, 17263, 17264, 17265, 17266, 17267, 17268], 17458: [463005],
  17815: [17833, 17834, 17835, 17836], 17877: [18867, 18868, 18869, 18870, 18871], 18126: [18127],
  18128: [18129], 18137: [19308, 19309, 19310, 19311, 19312, 28377, 28378, 28379, 28380, 28381, 28382],
  18179: [18180, 18181], 18265: [18879, 18880, 18881], 18310: [18311, 18312, 18313],
  18544: [18547, 18548, 18549, 18550], 18692: [18693], 18767: [18768], 18774: [18775],
  18821: [18822, 18823, 18824, 18825], 19151: [19152, 19153], 19184: [19185], 19286: [19287],
  19306: [20909, 20910, 1242634], 19381: [19382, 19383, 19384, 19385],
  19434: [20900, 20901, 20902, 20903, 20904], 19557: [19558], 19577: [24394], 19578: [24529, 1310725],
  19740: [19834, 19835, 19836, 19837, 19838, 25291], 19742: [19850, 19852, 19853, 19854, 25290],
  19750: [19939, 19940, 19941, 19942, 19943], 19870: [19871], 19876: [19895, 19896], 19888: [19897, 19898],
  19891: [19899, 19900], 19977: [19978, 19979], 20042: [20045, 20046, 20047, 20048], 20043: [20190],
  20091: [20092], 20148: [20149, 20150], 20154: [20287, 20288, 20289, 20290, 20291, 20292, 20293, 21084],
  20165: [20347, 20348, 20349], 20166: [20356, 20357], 20244: [20245], 20249: [20250, 20251],
  20252: [20616, 20617], 20335: [20336, 20337], 20359: [20360, 20361], 20375: [20915, 20918, 20919, 20920],
  20484: [20739, 20742, 20747, 20748], 20608: [21169], 20736: [14274, 15629, 15630, 15631, 15632],
  20925: [20927, 20928], 21082: [20162, 20305, 20306, 20307, 20308], 21562: [21564], 21849: [21850],
  22568: [22827, 22828, 22829, 31018], 22842: [22845], 23100: [23111, 23112], 23146: [23149, 23150],
  23163: [23166, 23167], 23759: [23760, 23761, 23762, 23785], 23881: [23892, 23893, 23894],
  23922: [23923, 23924, 23925], 23992: [24439, 24440, 24441, 24444, 24445, 24463, 24464],
  24118: [24119, 24120, 1299332], 24275: [24239, 24274], 24294: [24295], 24406: [19572],
  24424: [24580, 24581, 24582], 24446: [24447, 24448, 24449, 24475, 24476, 24477, 24478],
  24451: [24454, 24455], 24488: [24490, 24505, 24506, 24507, 24514, 24515, 24516],
  24492: [24494, 24502, 24503, 24504, 24511, 24512, 24513],
  24493: [24495, 24497, 24500, 24501, 24508, 24509, 24510],
  24545: [24547, 24549, 24550, 24551, 24552, 24553, 24554, 24555, 24556, 24557, 24558, 24559, 24560, 24561, 24562, 24629, 24630, 24631, 24632],
  24584: [24588, 24589, 24641], 24599: [24607, 24608, 24609], 24845: [25013, 25014, 25015, 25016, 25017],
  25675: [25858, 25859, 434508], 25782: [25916], 25863: [26655], 25894: [25918],
  26094: [26189, 26190, 1264456], 26573: [20116, 20922, 20923, 20924], 27811: [27813], 29074: [29077],
  29082: [29084, 29086, 29087, 29088], 29189: [29191], 29192: [29193], 29441: [29442], 30160: [30165],
  370637: [381598], 400574: [1239696, 1239697, 1239699, 1239700], 401502: [1237312, 1237313],
  401859: [1240826, 1240827], 401937: [1240770, 1240771, 1240772, 1240773, 1240774],
  402174: [1240720, 1240721, 1316995], 407995: [1238069, 1238070, 1238073], 408120: [1238214, 1238215],
  408341: [408342, 408343, 408344, 408345], 408490: [1238299, 1238300], 408521: [1239242, 1239243],
  412758: [1293812, 1293813], 414644: [1235826, 1235827], 436288: [463007],
  437138: [1237948, 1237949, 1237950, 1237951], 440892: [1311676, 1311677, 1311680], 444680: [444682],
  461607: [1237632], 468766: [5504, 5505, 5506, 6127, 10138, 10139, 10140], 473848: [473853, 473855],
  473858: [473859, 473860], 473869: [473870, 473871], 473874: [473875, 473877], 473882: [473886, 473887],
  1217142: [1217143, 1217144], 1217146: [1217147, 1217148], 1217150: [1217151, 1217152],
  1217154: [1217155, 1217156], 1240193: [1464, 8820, 11604, 11605],
  1264727: [1264729, 1264730, 1264731, 1264732], 1264745: [1264749, 1264750, 1264751, 1264752],
  1264937: [1264939, 1264970, 1264971, 1264972], 1265043: [1265045, 1265046, 1265047, 1265048],
  1265059: [1265060, 1265061, 1265062, 1265064], 1265831: [1265833, 1265834, 1265835, 1265836],
  1265887: [1265888, 1265890, 1265891, 1265892], 1265907: [1265908, 1265909, 1265911, 1265913],
  1277324: [1277325, 1277326, 1277327, 1277328], 1277331: [1277332, 1277333, 1277334, 1277335],
  1277370: [1277371, 1277372, 1277374, 1277376, 1277377, 1277378],
  1277462: [1277634, 1277638, 1277639, 1277640], 1293241: [1293525, 1293526, 1293527],
  1293817: [17962, 18930, 18931, 18932, 1293818], 1296017: [1309965, 1309973, 1310029, 1310030],
  1299346: [19506, 20905, 20906, 1299348], 1309595: [1309633, 1309635, 1309636], 1310687: [1310785, 1310786],
  1310707: [399956, 1241582, 1241584], 1310911: [1311590, 1311595], 1311606: [20473, 20929, 20930],
  1311649: [20163, 20419, 20421, 20422, 20423, 1311656], 1312002: [400640, 1240044, 1240045, 1240046, 1240047]
};
const RANK_ONE = new Map(Object.entries(RANK_CHAINS).flatMap(([first, ranks]) => ranks.map((id) => [id, Number(first)])));
const rankOne = (id) => RANK_ONE.get(id) ?? id;
// A count of the player's own casts of a spell on the current target.
const targetStack = (id, op, n) => ({ t: 'stack', id: rankOne(id), op, n, tgt: true });

// Combo points are a buff with stacks in the model (the simulator has no
// combo points of its own); One Button reads them directly.
const isCombo = (buff) => /combo/i.test(String(buff?.id ?? '')) || /combo/i.test(String(buff?.name ?? ''));

// The character's spells by lower-case name and by id, as the game listed them.
function spellIndex(spells) {
  const byName = new Map();
  const byId = new Map();
  for (const s of Array.isArray(spells) ? spells : []) {
    const name = str(s?.name, NAME_LEN);
    const id = spellId(s?.id);
    if (!name || id === null) continue;
    if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), { name, id });
    if (!byId.has(id)) byId.set(id, { name, id });
  }
  return { byName, byId };
}

// The translation's view of the model: which spell each ability and buff
// stands for in the character's own spell list. The buffs the addon saw on
// the character (auras: { name, id }) only tell a buff the player casts from
// one the game hides from addons during a fight.
function makeWorld(model, spells, auras) {
  const index = spellIndex(spells);
  const seen = spellIndex(auras).byName;
  const abilities = new Map((model.abilities || []).map((a) => [a.id, a]));
  const buffs = new Map((model.buffs || []).map((b) => [b.id, b]));
  // An ability's spell: its exact name wins; the model's own spellId only
  // counts when the character has a spell with that id.
  const abilitySpell = (ab) => {
    if (!ab) return null;
    const byName = index.byName.get(String(ab.name || '').toLowerCase());
    if (byName) return byName;
    const id = spellId(ab.spellId);
    return id !== null ? index.byId.get(id) || null : null;
  };
  const appliers = (buffId) => (model.abilities || []).filter((a) => (a.applies || []).includes(buffId));
  const firstSpell = (abs) => abs.map(abilitySpell).find(Boolean) || null;
  // The first ability of these that the character has, with its spell.
  const firstApplier = (abs) => {
    for (const ability of abs) { const spell = abilitySpell(ability); if (spell) return { ability, spell }; }
    return null;
  };
  // What a buff reference (buffUp and the like) names: a buff, or an
  // ability's dot by the ability's id, as the simulator looks them up.
  const effect = (ref) => {
    const buff = buffs.get(ref);
    if (buff) {
      if (isCombo(buff)) return { kind: 'combo', name: buff.name || buff.id };
      if (buff.onTarget) return { kind: 'target', name: buff.name || buff.id, appliers: appliers(buff.id), buff };
      // One Button follows a buff on the player from the player's cast of
      // it: one of the character's spells with its name, or the ability that
      // applies it. A buff only the addon saw (a proc, a talent's stored
      // stacks) is hidden from addons during a fight.
      const key = String(buff.name || '').toLowerCase();
      const spell = index.byName.get(key) || firstSpell(appliers(buff.id));
      return { kind: 'player', name: buff.name || buff.id, spell, hidden: !spell && seen.has(key), buff };
    }
    const ab = abilities.get(ref);
    if (ab && ab.dot) return { kind: 'target', name: ab.name || ab.id, appliers: [ab] };
    if (/combo/i.test(String(ref))) return { kind: 'combo', name: String(ref) };
    return { kind: 'unknown', name: String(ref) };
  };
  // The buff on the player that One Button sees as this spell's own (the one
  // it names by this spell), the longest if several; 0 lasts all fight.
  const ownBuff = (ability, spell) => (ability.applies || [])
    .map((id) => buffs.get(id))
    .filter((b) => b && !b.onTarget && !isCombo(b) && effect(b.id).spell?.id === spell.id)
    .sort((a, b) => (b.duration || Infinity) - (a.duration || Infinity))[0] || null;
  // Two buffs that are never up together: every ability that starts one ends
  // the other, and neither comes from a proc or is up from the start (one
  // seal at a time).
  const fromProc = (id) => (model.procs || []).some((p) => p.effect?.buff === id);
  const ends = (starters, id) => starters.length > 0 && starters.every((a) => (a.consumes || []).includes(id));
  const apart = (x, y) => x !== y && [x, y].every((id) => buffs.has(id) && !buffs.get(id).initial && !fromProc(id))
    && ends(appliers(x), y) && ends(appliers(y), x);
  const nameOf = (ref) => buffs.get(ref)?.name || abilities.get(ref)?.name || String(ref);
  return { abilities, abilitySpell, firstSpell, firstApplier, effect, ownBuff, apart, nameOf, resource: model.player?.resource?.type || 'none' };
}

// The opposite of a condition, in the model's own terms where it has one and
// in a few keys of this module's own (starting with "_") where it has not.
// A "not" over several keys is an "any" of their opposites; the opposite of
// an "any" is all of the opposites.
const OPPOSITE = {
  resourceAtLeast: (v) => ({ resourceBelow: v }),
  resourceBelow: (v) => ({ resourceAtLeast: v }),
  buffUp: (v) => ({ buffDown: v }),
  buffDown: (v) => ({ buffUp: v }),
  buffStacksAtLeast: (v) => ({ _stacksBelow: v }),
  buffRemainsBelow: (v) => ({ _remainsAtLeast: v }),
  cooldownUp: (v) => ({ _onCooldown: v }),
  cooldownRemainsAbove: (v) => ({ _lost: true, _what: 'cooldownAtMost', _v: v }),
  targetHealthBelow: (v) => ({ targetHealthAbove: v }),
  targetHealthAbove: (v) => ({ _healthAtMost: v }),
  targetsAtLeast: (v) => ({ _targetsBelow: v }),
  swingTimerAbove: (v) => ({ _swingAtMost: v }),
  usedOnTarget: (v) => ({ _notUsed: v }),
  usedWithin: (v) => ({ _notWithin: v }),
  timeAtLeast: (v) => ({ timeAtLeast: v, _negated: true }),
  timeRemainingBelow: (v) => ({ timeRemainingBelow: v, _negated: true }),
  any: (v) => ({ _all: (v || []).map(negate) }),
  not: (v) => v,
};
function negate(cond) {
  const keys = Object.keys(cond || {});
  if (keys.length > 1) return { any: keys.map((k) => negate({ [k]: cond[k] })) };
  const [key] = keys;
  const flip = OPPOSITE[key];
  return flip ? flip(cond[key]) : { _lost: true, _what: key, _v: cond[key] };
}

// A condition in a few plain words, for the lines the player reads.
function phrase(key, v, world, negated) {
  const name = (ref) => world.nameOf(ref);
  // "usedOnTarget" is an ability's id for one use, { id, times } for more.
  const uses = typeof v === 'string' ? null : v?.times;
  const counted = `on the target in the last ${COUNTED_SECONDS} seconds`;
  const run = `on the target, each within ${COUNTED_SECONDS} seconds of the one before`;
  const res = world.resource === 'none' ? 'resource' : world.resource;
  const words = {
    timeAtLeast: () => `${v} seconds into the fight`,
    timeRemainingBelow: () => `the last ${v} seconds of the fight`,
    cooldownAtMost: () => `${name(v?.id)} being ready within ${v?.sec} seconds`,
    buffUp: () => `${name(v)} being up`,
    buffDown: () => `${name(v)} being down`,
    buffStacksAtLeast: () => `${v?.n} or more stacks of ${name(v?.id)}`,
    _stacksBelow: () => `fewer than ${v?.n} stacks of ${name(v?.id)}`,
    cooldownUp: () => `${name(v)} being ready`,
    _onCooldown: () => `${name(v)} being on cooldown`,
    cooldownRemainsAbove: () => `${name(v?.id)} being on cooldown`,
    resourceAtLeast: () => `${res} at ${v} or more`,
    resourceBelow: () => `${res} below ${v}`,
    targetHealthBelow: () => `the target below ${v}% health`,
    targetHealthAbove: () => `the target at ${v}% health or more`,
    _healthAtMost: () => `the target at ${v}% health or less`,
    targetsAtLeast: () => `${v} or more enemies`,
    _targetsBelow: () => `fewer than ${v} enemies`,
    swingTimerAbove: () => `more than ${v} seconds before the next swing`,
    _swingAtMost: () => `${v} seconds or less before the next swing`,
    usedOnTarget: () => (uses ? `${name(v?.id)} used ${uses} times ${run}` : `${name(v)} used ${counted}`),
    _notUsed: () => (uses ? `${name(v?.id)} used fewer than ${uses} times ${run}` : `${name(v)} not used ${counted}`),
    usedWithin: () => `${name(v?.id)} used in the last ${v?.sec} seconds`,
    _notWithin: () => `${name(v?.id)} not used in the last ${v?.sec} seconds`,
  }[key];
  if (negated && key === 'timeAtLeast') return `the first ${v} seconds of the fight`;
  if (negated && key === 'timeRemainingBelow') return `the fight before its last ${v} seconds`;
  const said = words ? words() : 'a condition';
  return negated ? `not ${said}` : said;
}

// One condition translated: the gates, the model conditions they stand for
// (conds, each of one key, all of which must hold), what could not be carried
// over (lost), what was carried over only roughly (approx) and what was cut
// by One Button's limits (cut).
const result = () => ({ gates: [], conds: [], lost: [], approx: [], cut: [] });
function merge(into, part) {
  into.gates.push(...part.gates);
  into.conds.push(...part.conds);
  into.lost.push(...part.lost);
  into.approx.push(...part.approx);
  into.cut.push(...part.cut);
  return into;
}
const lost = (what) => ({ ...result(), lost: [what] });
// cond: what the gate means in the model's language.
function gate(g, key, v, world, cond) {
  if (!inRange(g)) return lost(phrase(key, v, world));
  return { ...result(), gates: [g], conds: [cond] };
}
const not = (cond) => ({ not: cond });

// Conditions of one key each as one condition object. Two of the same key
// (two buffs that must be down) go into "all", which the simulator reads too.
function andOf(conds) {
  const out = {};
  const more = [];
  for (const c of conds) {
    const [key] = Object.keys(c);
    if (key in out) more.push(c); else out[key] = c[key];
  }
  if (more.length) out.all = [...(out.all || []), ...more];
  return out;
}

// The keys of one condition, at a depth of One Button's nesting.
function translate(cond, depth, act) {
  const out = result();
  if (!cond) return out;
  for (const [key, v] of Object.entries(cond)) {
    // Markers of this module's own opposites ride along with their key.
    if (key.startsWith('_') && !TRANSLATE[key]) continue;
    const fn = TRANSLATE[key];
    if (!fn) { out.lost.push(phrase(key, v, act.world)); continue; }
    merge(out, fn(v, depth, act, cond));
  }
  // The same gate twice (from "requires" and "if" alike) is one gate.
  out.gates = unique(out.gates);
  out.conds = unique(out.conds);
  return out;
}

function power(op, n, key, act) {
  const { world, ability } = act;
  if (world.resource === 'none') return result();
  // At or below the ability's own cost, One Button's usability check says the same.
  if (op === '>=' && !(n > (ability.cost || 0))) return result();
  return gate({ t: 'power', res: world.resource, op, n }, key, n, world, { [key]: n });
}

// What One Button cannot read of a buff in a fight, said as such and short
// enough for the whole line to fit.
const unread = (name, stacked) => `${name}${stacked ? "'s stacks" : ''}, hidden in a fight`;

// buffUp / buffDown and their stack forms. up: the effect wanted present.
function presence(ref, up, act, key) {
  const { world, ability } = act;
  const e = world.effect(ref);
  const same = up ? { buffUp: ref } : { buffDown: ref };
  if (e.kind === 'combo') return gate({ t: 'resource', res: 'combo_points', op: up ? '>=' : '<', n: 1 }, key, ref, world, same);
  if (e.kind === 'player') {
    if (!e.spell) return lost(e.hidden ? unread(e.name) : phrase(key, ref, world));
    const g = { t: 'buff', id: e.spell.id };
    if (e.buff.duration > 0) g.dur = e.buff.duration;
    if (!up) g.neg = true;
    return gate(g, key, ref, world, same);
  }
  if (e.kind === 'target') {
    // Kept up on the target by the very ability that puts it there.
    if (!up && e.appliers.some((a) => a.id === ability.id)) return keepUp(e, act, key, ref);
    return onTarget(e, up ? '>=' : '<', 1, act, key, ref, same);
  }
  return lost(phrase(key, ref, world));
}

// An effect on the target kept up by its own ability. A DoT One Button
// tracks holds itself back while it is up; so does an ability whose own
// cooldown paces it. Anything else is counted from the player's casts.
function keepUp(e, act, key, ref) {
  const { world, ability, spell } = act;
  if (TRACKED_DOTS.has(spell.id)) return gate({ t: 'dot', id: spell.id }, key, ref, world, { buffDown: ref });
  // Only informational to One Button: the cooldown alone paces it, so the
  // simulated list has no condition there.
  if (hasCooldown(ability)) return { ...result(), gates: [{ t: 'dot', id: spell.id }] };
  const part = gate(targetStack(spell.id, '<', 1), key, ref, world, not({ usedOnTarget: ability.id }));
  if (!part.lost.length) part.approx.push(`keeps up ${e.name}, which One Button does not track: it waits about ${COUNTED_SECONDS} seconds between uses on the same target`);
  return part;
}

// Any other condition on an effect on the target. One Button cannot be asked
// about a DoT it tracks itself (a stack gate would stop the tracking); any
// other effect is counted from the player's own casts, which for one
// application is the applier's use in the last 30 seconds. same: the model's
// own condition, simulated as it is for more applications.
function onTarget(e, op, n, act, key, v, same) {
  const { world } = act;
  const found = world.firstApplier(e.appliers);
  if (!found) return lost(phrase(key, v, world));
  const applier = found.spell;
  if (TRACKED_DOTS.has(applier.id)) return lost(`${phrase(key, v, world)} (One Button keeps track of that effect itself and offers no condition on it)`);
  const used = { usedOnTarget: found.ability.id };
  const cond = n === 1 ? (op === '>=' ? used : not(used)) : same;
  const part = gate(targetStack(applier.id, op, n), key, v, world, cond);
  if (!part.lost.length) part.approx.push(`counts ${e.name} on the target from your own casts, about ${COUNTED_SECONDS} seconds each`);
  return part;
}

function stacks(v, atLeast, act, key) {
  const { world } = act;
  const e = world.effect(v?.id);
  const n = num(v?.n);
  if (n === null) return lost(phrase(key, v, world));
  const same = atLeast ? { buffStacksAtLeast: v } : not({ buffStacksAtLeast: v });
  if (e.kind === 'combo') return gate({ t: 'resource', res: 'combo_points', op: atLeast ? '>=' : '<', n }, key, v, world, same);
  if (e.kind === 'target') return onTarget(e, atLeast ? '>=' : '<', n, act, key, v, same);
  // The stacks of a buff on the player are hidden from addons in a fight,
  // even of one the player casts.
  if (e.kind === 'player' && (e.spell || e.hidden)) return lost(unread(e.name, true));
  return lost(phrase(key, v, world));
}

function cooldown(ref, onCooldown, act, key) {
  const { world, ability } = act;
  // Its own cooldown being over is what One Button checks anyway.
  if (!onCooldown && ref === ability.id) return result();
  const spell = world.abilitySpell(world.abilities.get(ref));
  if (!spell) return lost(phrase(key, ref, world));
  const g = { t: 'cd', id: spell.id };
  if (onCooldown) g.neg = true;
  return gate(g, key, ref, world, onCooldown ? not({ cooldownUp: ref }) : { cooldownUp: ref });
}

// An ability's uses on the target, each within 30 seconds of the one before,
// as One Button counts them: a target stack gate on its spell. v: the
// ability's id for one use, { id, times } for more. Not for a DoT One Button
// tracks itself, which a stack gate would stop it tracking.
function used(v, wanted, act, key) {
  const { world } = act;
  const ref = typeof v === 'string' ? v : v?.id;
  const n = typeof v === 'string' ? 1 : num(v?.times) ?? 1;
  const spell = world.abilitySpell(world.abilities.get(ref));
  if (!spell) return lost(phrase(key, v, world));
  if (TRACKED_DOTS.has(spell.id)) return lost(`${phrase(key, v, world)} (One Button keeps track of that effect itself and offers no condition on it)`);
  const cond = { usedOnTarget: v };
  return gate(targetStack(spell.id, wanted ? '>=' : '<', n), key, v, world, wanted ? cond : not(cond));
}

// An ability not used in the last sec seconds: One Button's buff gate on its
// spell, negated, holds back for sec seconds after the cast
// (State.BuffActive). It also holds back while that spell's own buff is up,
// so a buff that outlasts sec is waited for too, unless the action already
// asks for a buff that is never up with it. The positive form cannot be
// carried over: once the time has passed One Button has no answer.
function notWithin(v, act) {
  const { world } = act;
  const ability = world.abilities.get(v?.id);
  const spell = world.abilitySpell(ability);
  if (!spell) return lost(phrase('_notWithin', v, world));
  const part = gate({ t: 'buff', id: spell.id, dur: v.sec, neg: true }, '_notWithin', v, world, not({ usedWithin: v }));
  const own = part.lost.length ? null : world.ownBuff(ability, spell);
  if (!own || (own.duration > 0 && own.duration <= v.sec)) return part;
  const given = act.given.filter(Boolean);
  if (given.some((c) => c.buffDown === own.id || world.apart(c.buffUp, own.id))) return part;
  part.conds.push({ buffDown: own.id });
  part.approx.push(`also waits while ${own.name || own.id} is up: One Button holds it back for as long as that buff lasts`);
  return part;
}

// An "or": every member must be carried over, or none of it is (dropping a
// branch would make it stricter than the model). A member that only restated
// what One Button checks itself makes the whole "or" always true.
function anyOf(members, depth, act) {
  if (!members.length) return lost('a condition that never holds');
  if (depth >= MAX_DEPTH) return lost('a condition nested too deeply');
  const out = result();
  const g = [];
  const conds = [];
  for (const member of members) {
    let part = translate(member, depth + 1, act);
    // A member of several gates becomes a group of its own, one level down.
    if (part.gates.length > 1) part = translate(member, depth + 2, act);
    if (part.lost.length) return lost(`an either-or condition that includes ${part.lost[0]}`);
    out.approx.push(...part.approx);
    out.cut.push(...part.cut);
    if (!part.gates.length) return result();
    // A member that holds back nothing in One Button makes the "or" always true there.
    conds.push(part.conds.length ? andOf(part.conds) : null);
    if (part.gates.length === 1) { g.push(part.gates[0]); continue; }
    if (depth + 1 >= MAX_DEPTH) return lost('a condition nested too deeply');
    if (part.gates.length > MAX_GATES) { out.cut.push('group'); part.gates.length = MAX_GATES; }
    g.push({ t: 'all', g: part.gates });
  }
  if (g.length > MAX_GATES) { out.cut.push('group'); g.length = MAX_GATES; conds.length = MAX_GATES; }
  out.gates.push({ t: 'any', g });
  if (!conds.includes(null)) out.conds.push({ any: conds });
  return out;
}

const TRANSLATE = {
  resourceAtLeast: (v, d, act) => power('>=', v, 'resourceAtLeast', act),
  resourceBelow: (v, d, act) => power('<', v, 'resourceBelow', act),
  buffUp: (v, d, act) => presence(v, true, act, 'buffUp'),
  buffDown: (v, d, act) => presence(v, false, act, 'buffDown'),
  buffStacksAtLeast: (v, d, act) => stacks(v, true, act, 'buffStacksAtLeast'),
  _stacksBelow: (v, d, act) => stacks(v, false, act, '_stacksBelow'),
  // One Button cannot compare the time a buff has left: it is treated as
  // missing, so the ability refreshes it only once it has run out.
  buffRemainsBelow: (v, d, act) => {
    const part = presence(v?.id, false, act, 'buffDown');
    if (!part.lost.length) part.approx.push(`refreshes ${act.world.nameOf(v?.id)} only once it has run out, not shortly before`);
    return part;
  },
  _remainsAtLeast: (v, d, act) => {
    const part = presence(v?.id, true, act, 'buffUp');
    if (!part.lost.length) part.approx.push(`waits only for ${act.world.nameOf(v?.id)} to be up, whatever time it has left`);
    return part;
  },
  cooldownUp: (v, d, act) => cooldown(v, false, act, 'cooldownUp'),
  _onCooldown: (v, d, act) => cooldown(v, true, act, '_onCooldown'),
  // Only "on cooldown" can be asked, not how long is left.
  cooldownRemainsAbove: (v, d, act) => {
    const part = cooldown(v?.id, true, act, 'cooldownRemainsAbove');
    if (!part.lost.length) part.approx.push(`waits for ${act.world.nameOf(v?.id)} to be on cooldown, not for how long it has left`);
    return part;
  },
  targetHealthBelow: (v, d, act) => gate({ t: 'execute', op: '<', pct: v }, 'targetHealthBelow', v, act.world, { targetHealthBelow: v }),
  targetHealthAbove: (v, d, act) => gate({ t: 'execute', op: '>=', pct: v }, 'targetHealthAbove', v, act.world, { targetHealthAbove: v }),
  _healthAtMost: (v, d, act) => gate({ t: 'execute', op: '<=', pct: v }, '_healthAtMost', v, act.world, not({ targetHealthAbove: v })),
  targetsAtLeast: (v, d, act) => gate({ t: 'targets', op: '>=', n: v }, 'targetsAtLeast', v, act.world, { targetsAtLeast: v }),
  _targetsBelow: (v, d, act) => gate({ t: 'targets', op: '<', n: v }, '_targetsBelow', v, act.world, not({ targetsAtLeast: v })),
  swingTimerAbove: (v, d, act) => gate({ t: 'swing', op: '>', n: v }, 'swingTimerAbove', v, act.world, { swingTimerAbove: v }),
  _swingAtMost: (v, d, act) => gate({ t: 'swing', op: '<=', n: v }, '_swingAtMost', v, act.world, not({ swingTimerAbove: v })),
  usedOnTarget: (v, d, act) => used(v, true, act, 'usedOnTarget'),
  _notUsed: (v, d, act) => used(v, false, act, '_notUsed'),
  // Only its opposite: once the time has passed One Button has no answer.
  usedWithin: (v, d, act) => lost(phrase('usedWithin', v, act.world)),
  _notWithin: (v, d, act) => notWithin(v, act),
  // One Button knows nothing of the fight's clock.
  timeAtLeast: (v, d, act, cond) => lost(phrase('timeAtLeast', v, act.world, cond._negated)),
  timeRemainingBelow: (v, d, act, cond) => lost(phrase('timeRemainingBelow', v, act.world, cond._negated)),
  _lost: (v, d, act, cond) => lost(phrase(cond._what, cond._v, act.world, cond._what !== 'cooldownAtMost')),
  any: (v, d, act) => anyOf(Array.isArray(v) ? v : [], d, act),
  // "All of these" at the same level: their gates simply stand side by side.
  _all: (v, d, act) => (Array.isArray(v) ? v : []).reduce((out, c) => merge(out, translate(c, d, act)), result()),
  not: (v, d, act) => translate(negate(v), d, act),
};

// A real cooldown keeps an ability from always coming first on its own.
const hasCooldown = (ab) => ab.cooldown > 0 && ab.cooldown > (ab.gcd || 0);

// The lines the player reads: actions left out first, then conditions left
// out, then approximations; each once, cut to fit.
function leftLines(notes) {
  const out = [];
  for (const level of [0, 1, 2]) {
    for (const n of notes) {
      if (n.level !== level) continue;
      const line = text(n.line, LEFT_LEN);
      if (line && !out.includes(line)) out.push(line);
    }
  }
  return out.slice(0, MAX_LEFT);
}
const joined = (parts) => [...new Set(parts)].slice(0, 2).join(' and ');


// One action of the list translated on its own: its spell, its gates, the
// model conditions of its "if" as One Button would check them (requires
// stays the ability's own in the model, the game holds it back too) and the
// lines about it, or null when it was left out (with a line).
function occurrence(action, place, world, dropped) {
  const ability = world.abilities.get(action.use);
  if (!ability) return null;
  const spell = world.abilitySpell(ability);
  const name = ability.name || ability.id;
  if (!spell) { dropped.push({ level: 0, line: `${name} was left out: the character's spell list has no such spell.` }); return null; }
  // given: the action's own conditions, which a hold One Button adds by
  // itself may already cover.
  const act = { world, ability, spell, given: [action.if, ability.requires] };
  const req = translate(ability.requires, 1, act);
  const when = translate(action.if, 1, act);
  const reqConds = [...req.conds];
  const ifConds = [...when.conds];
  // One Button holds back a DoT it tracks while it runs, asked or not.
  if (TRACKED_DOTS.has(spell.id) && ability.dot) ifConds.push({ buffDown: ability.id });
  const both = merge(req, when);
  both.gates = unique(both.gates);
  if (both.lost.length && !hasCooldown(ability)) {
    dropped.push({ level: 0, spellId: spell.id, name: spell.name, why: `One Button cannot check for ${joined(both.lost)}, and without it the spell would always come first.` });
    return null;
  }
  const notes = [];
  if (both.lost.length) notes.push({ level: 1, line: `${spell.name} is suggested without checking for ${joined(both.lost)}, which One Button cannot do.` });
  if (both.gates.length > MAX_GATES) { both.cut.push('entry'); both.gates.length = MAX_GATES; }
  if (both.cut.length) notes.push({ level: 1, line: `${spell.name} keeps only the first ${MAX_GATES} of its conditions.` });
  for (const a of both.approx) notes.push({ level: 2, line: `${spell.name} ${a}.` });
  return { place, ability, spell, gates: both.gates, reqConds, ifConds: unique(ifConds), notes };
}

const unique = (items) => {
  const seen = new Set();
  return items.filter((g) => { const k = JSON.stringify(g); if (seen.has(k)) return false; seen.add(k); return true; });
};
const isGroup = (g) => g.t === 'any' || g.t === 'all';
// The model action an occurrence stands for, with these conditions.
const actionOf = (occ, conds) => (conds.length ? { use: occ.ability.id, if: andOf(conds) } : { use: occ.ability.id });

// One spell's places in the list as the one entry One Button reads (its
// queue takes each spell once, Engine/Queue.lua). A first place without
// conditions makes the later ones redundant. Otherwise the places up to the
// first one without conditions become one entry at the last of them, held
// back unless the conditions of one of them hold: never suggested where the
// model would not use it, never above what the model ranks higher; only the
// earlier places are lost. Each entry carries its model action (action).
function oneEntry(occs) {
  const [first] = occs;
  if (!first.gates.length || occs.length === 1) return { ...first, notes: [...first.notes], action: actionOf(first, first.ifConds) };
  const plain = occs.findIndex((o) => !o.gates.length);
  const taken = plain >= 0 ? occs.slice(0, plain + 1) : occs;
  const last = taken[taken.length - 1];
  const name = last.spell.name;
  const notes = taken.flatMap((o) => o.notes);
  const line = (rest) => ({ level: 2, twice: true, line: `${name} is listed more than once: One Button reads each ability once, so it keeps its lowest place${rest}.` });
  const own = actionOf(last, last.ifConds);
  // A plain place took the others in: what was said about their conditions
  // no longer describes the entry.
  if (!last.gates.length) return { ...last, notes: [...last.notes, line('')], action: own };
  // Several gates of which one is a group would need a group at depth 3.
  if (taken.some((o) => o.gates.length > 1 && o.gates.some(isGroup))) {
    return { ...last, notes: [...last.notes, line(', with only the conditions it has there')], action: own };
  }
  let members = unique(taken.flatMap((o) => {
    if (o.gates.length > 1) return [{ t: 'all', g: o.gates }];
    return o.gates[0].t === 'any' ? o.gates[0].g : o.gates;
  }));
  if (members.length > MAX_GATES) {
    members = members.slice(0, MAX_GATES);
    notes.push({ level: 1, line: `${name} keeps only the first ${MAX_GATES} of its conditions.` });
  }
  // In the model: any of the places' own conditions; a place with none of
  // its own makes it always true.
  const places = taken.map((o) => [...o.reqConds, ...o.ifConds]);
  const action = places.some((c) => !c.length) ? { use: last.ability.id } : { use: last.ability.id, if: { any: places.map(andOf) } };
  return { ...last, gates: [{ t: 'any', g: members }], notes: [...notes, line(', for the conditions of any of its places')], action };
}

/**
 * A priority list cleaned into what One Button can play. model: the
 * validated model; rotation: { actions } in the model's language; spells:
 * the character's spells as the game listed them; auras: buffs the addon saw
 * on the character ({ name, id }). Returns null when nothing could be carried
 * over, else { list: [{ id, name, gates }], actions (the same list in the
 * model's language, to simulate), left (lines for the player), problems (the
 * lines that say what broke One Button's rules) }.
 */
export function cleanRotation(model, rotation, spells, { auras = [] } = {}) {
  if (!model || !rotation) return null;
  const world = makeWorld(model, spells, auras);
  const dropped = [];
  const bySpell = new Map();
  (rotation.actions || []).forEach((action, place) => {
    const occ = occurrence(action, place, world, dropped);
    if (!occ) return;
    if (!bySpell.has(occ.spell.id)) bySpell.set(occ.spell.id, []);
    bySpell.get(occ.spell.id).push(occ);
  });
  let entries = [...bySpell.values()].map(oneEntry).sort((a, b) => a.place - b.place);
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(0, MAX_ENTRIES);
    dropped.push({ level: 0, line: `Only the first ${MAX_ENTRIES} abilities of the rotation were carried over.` });
  }
  if (!entries.length) return null;
  // A place left out of a spell that still has an entry is one use of it
  // left out, not the spell: said with the conditions left out.
  const listed = new Set(entries.map((e) => e.spell.id));
  const said = dropped.map((d) => {
    if (!d.why) return d;
    if (listed.has(d.spellId)) return { level: 1, line: `One use of ${d.name} was left out: ${d.why}` };
    return { level: 0, line: `${d.name} was left out: ${d.why}` };
  });
  const notes = [...said, ...entries.flatMap((e) => e.notes)];
  return {
    list: entries.map((e) => ({ id: e.spell.id, name: e.spell.name, gates: e.gates })),
    actions: entries.map((e) => e.action),
    left: leftLines(notes),
    // Approximations are One Button's limits, not mistakes in the list.
    problems: leftLines(notes.filter((n) => n.level < 2 || n.twice)),
  };
}

/**
 * A rotation as a One Button priority list, without measuring it: { v,
 * context ("st" or "aoe"), rotation (its name), list, left? }, or null when
 * nothing could be translated.
 */
export function oneButtonList(model, rotation, spells, context = 'st', { auras = [] } = {}) {
  const cleaned = cleanRotation(model, rotation, spells, { auras });
  if (!cleaned) return null;
  const out = {
    v: ONE_BUTTON_VERSION,
    context: context === 'aoe' ? 'aoe' : 'st',
    rotation: str(rotation.name, NAME_LEN) || 'Rotation',
    list: cleaned.list,
  };
  if (cleaned.left.length) out.left = cleaned.left;
  return out;
}

/**
 * The One Button list for one kind of fight ("short" or "long"): the AI's
 * own list for it (model.oneButton[kind]) when it has one that can be carried
 * over, else the best candidate of that fight (best: { name, actions }).
 * measure(actions) simulates the cleaned list in that fight and returns its
 * value, so what is exported is what was measured. Returns { list: { v,
 * context, source, rotation?, list, left?, value } or null, problems: what
 * was wrong with the AI's list }.
 */
export function oneButtonFor(model, { kind, best, spells, auras = [], context = 'st', measure }) {
  const problems = [];
  const own = model?.oneButton?.[kind];
  let cleaned = null;
  let source = 'ai';
  if (Array.isArray(own) && own.length) {
    cleaned = cleanRotation(model, { actions: own }, spells, { auras });
    if (cleaned) problems.push(...cleaned.problems);
    else problems.push('None of its abilities could be carried over to One Button: the best candidate was used instead.');
  }
  if (!cleaned) {
    cleaned = cleanRotation(model, best, spells, { auras });
    source = 'best';
  }
  if (!cleaned) return { list: null, problems };
  const out = { v: ONE_BUTTON_VERSION, context: context === 'aoe' ? 'aoe' : 'st', source };
  if (source === 'best') out.rotation = str(best.name, NAME_LEN) || 'Rotation';
  out.list = cleaned.list;
  if (cleaned.left.length) out.left = cleaned.left;
  out.value = measure(cleaned.actions);
  return { list: out, problems };
}
