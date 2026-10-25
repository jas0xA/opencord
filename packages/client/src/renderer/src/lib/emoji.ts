// A compact built-in emoji set (no external data). name → char, grouped by category.
export const EMOJI_CATEGORIES: { id: string; label: string; icon: string; emojis: [string, string][] }[] = [
  {
    id: 'people', label: 'People', icon: '😀',
    emojis: [
      ['grinning', '😀'], ['smiley', '😃'], ['smile', '😄'], ['grin', '😁'], ['laughing', '😆'], ['sweat_smile', '😅'], ['rofl', '🤣'], ['joy', '😂'],
      ['slight_smile', '🙂'], ['upside_down', '🙃'], ['wink', '😉'], ['blush', '😊'], ['innocent', '😇'], ['smiling_face_with_hearts', '🥰'], ['heart_eyes', '😍'],
      ['star_struck', '🤩'], ['kissing_heart', '😘'], ['yum', '😋'], ['stuck_out_tongue', '😛'], ['stuck_out_tongue_winking_eye', '😜'], ['zany', '🤪'],
      ['money_mouth', '🤑'], ['hugging', '🤗'], ['hand_over_mouth', '🤭'], ['shushing', '🤫'], ['thinking', '🤔'], ['zipper_mouth', '🤐'], ['raised_eyebrow', '🤨'],
      ['neutral_face', '😐'], ['expressionless', '😑'], ['no_mouth', '😶'], ['smirk', '😏'], ['unamused', '😒'], ['rolling_eyes', '🙄'], ['grimacing', '😬'],
      ['relieved', '😌'], ['pensive', '😔'], ['sleepy', '😪'], ['drooling', '🤤'], ['sleeping', '😴'], ['mask', '😷'], ['nauseated', '🤢'], ['vomiting', '🤮'],
      ['sneezing', '🤧'], ['hot_face', '🥵'], ['cold_face', '🥶'], ['woozy', '🥴'], ['dizzy_face', '😵'], ['exploding_head', '🤯'], ['cowboy', '🤠'],
      ['partying_face', '🥳'], ['sunglasses', '😎'], ['nerd', '🤓'], ['monocle', '🧐'], ['confused', '😕'], ['worried', '😟'], ['frowning', '🙁'],
      ['open_mouth', '😮'], ['hushed', '😯'], ['astonished', '😲'], ['flushed', '😳'], ['pleading', '🥺'], ['fearful', '😨'], ['cold_sweat', '😰'],
      ['cry', '😢'], ['sob', '😭'], ['scream', '😱'], ['confounded', '😖'], ['persevere', '😣'], ['disappointed', '😞'], ['sweat', '😓'], ['weary', '😩'],
      ['tired_face', '😫'], ['yawning', '🥱'], ['triumph', '😤'], ['rage', '😡'], ['angry', '😠'], ['cursing', '🤬'], ['smiling_imp', '😈'], ['skull', '💀'],
      ['poop', '💩'], ['clown', '🤡'], ['ghost', '👻'], ['alien', '👽'], ['robot', '🤖'], ['wave', '👋'], ['ok_hand', '👌'], ['pinched_fingers', '🤌'],
      ['v', '✌️'], ['crossed_fingers', '🤞'], ['love_you', '🤟'], ['metal', '🤘'], ['call_me', '🤙'], ['point_left', '👈'], ['point_right', '👉'],
      ['point_up', '👆'], ['point_down', '👇'], ['thumbsup', '👍'], ['thumbsdown', '👎'], ['fist', '✊'], ['punch', '👊'], ['clap', '👏'],
      ['raised_hands', '🙌'], ['open_hands', '👐'], ['handshake', '🤝'], ['pray', '🙏'], ['muscle', '💪'], ['eyes', '👀'], ['brain', '🧠'],
      ['salute', '🫡'], ['melting_face', '🫠'], ['face_holding_back_tears', '🥹'], ['nail_care', '💅'], ['person_facepalming', '🤦'], ['person_shrugging', '🤷'],
    ],
  },
  {
    id: 'nature', label: 'Nature', icon: '🐱',
    emojis: [
      ['dog', '🐶'], ['cat', '🐱'], ['mouse', '🐭'], ['hamster', '🐹'], ['rabbit', '🐰'], ['fox', '🦊'], ['bear', '🐻'], ['panda', '🐼'], ['koala', '🐨'],
      ['tiger', '🐯'], ['lion', '🦁'], ['cow', '🐮'], ['pig', '🐷'], ['frog', '🐸'], ['monkey', '🐵'], ['chicken', '🐔'], ['penguin', '🐧'], ['bird', '🐦'],
      ['duck', '🦆'], ['eagle', '🦅'], ['owl', '🦉'], ['bat', '🦇'], ['wolf', '🐺'], ['horse', '🐴'], ['unicorn', '🦄'], ['bee', '🐝'], ['bug', '🐛'],
      ['butterfly', '🦋'], ['snail', '🐌'], ['turtle', '🐢'], ['snake', '🐍'], ['dragon', '🐉'], ['octopus', '🐙'], ['crab', '🦀'], ['fish', '🐟'],
      ['dolphin', '🐬'], ['whale', '🐳'], ['shark', '🦈'], ['cactus', '🌵'], ['evergreen_tree', '🌲'], ['palm_tree', '🌴'], ['seedling', '🌱'], ['herb', '🌿'],
      ['four_leaf_clover', '🍀'], ['maple_leaf', '🍁'], ['mushroom', '🍄'], ['rose', '🌹'], ['sunflower', '🌻'], ['cherry_blossom', '🌸'], ['tulip', '🌷'],
      ['sun', '☀️'], ['crescent_moon', '🌙'], ['star', '⭐'], ['star2', '🌟'], ['sparkles', '✨'], ['zap', '⚡'], ['fire', '🔥'], ['rainbow', '🌈'],
      ['cloud', '☁️'], ['snowflake', '❄️'], ['snowman', '⛄'], ['droplet', '💧'], ['ocean', '🌊'], ['earth', '🌍'],
    ],
  },
  {
    id: 'food', label: 'Food', icon: '🍕',
    emojis: [
      ['apple', '🍎'], ['green_apple', '🍏'], ['banana', '🍌'], ['watermelon', '🍉'], ['grapes', '🍇'], ['strawberry', '🍓'], ['cherries', '🍒'], ['peach', '🍑'],
      ['mango', '🥭'], ['pineapple', '🍍'], ['coconut', '🥥'], ['avocado', '🥑'], ['eggplant', '🍆'], ['carrot', '🥕'], ['corn', '🌽'], ['hot_pepper', '🌶️'],
      ['bread', '🍞'], ['cheese', '🧀'], ['egg', '🥚'], ['bacon', '🥓'], ['hamburger', '🍔'], ['fries', '🍟'], ['pizza', '🍕'], ['hotdog', '🌭'],
      ['taco', '🌮'], ['burrito', '🌯'], ['sushi', '🍣'], ['ramen', '🍜'], ['spaghetti', '🍝'], ['dumpling', '🥟'], ['popcorn', '🍿'], ['doughnut', '🍩'],
      ['cookie', '🍪'], ['cake', '🎂'], ['cupcake', '🧁'], ['chocolate_bar', '🍫'], ['candy', '🍬'], ['lollipop', '🍭'], ['ice_cream', '🍨'], ['coffee', '☕'],
      ['tea', '🍵'], ['bubble_tea', '🧋'], ['beer', '🍺'], ['beers', '🍻'], ['wine_glass', '🍷'], ['cocktail', '🍸'], ['tropical_drink', '🍹'], ['champagne', '🍾'],
    ],
  },
  {
    id: 'activities', label: 'Activities', icon: '⚽',
    emojis: [
      ['soccer', '⚽'], ['basketball', '🏀'], ['football', '🏈'], ['baseball', '⚾'], ['tennis', '🎾'], ['volleyball', '🏐'], ['8ball', '🎱'], ['ping_pong', '🏓'],
      ['trophy', '🏆'], ['medal', '🏅'], ['first_place', '🥇'], ['video_game', '🎮'], ['joystick', '🕹️'], ['game_die', '🎲'], ['chess_pawn', '♟️'],
      ['dart', '🎯'], ['bowling', '🎳'], ['guitar', '🎸'], ['microphone', '🎤'], ['headphones', '🎧'], ['musical_note', '🎵'], ['notes', '🎶'], ['art', '🎨'],
      ['clapper', '🎬'], ['tada', '🎉'], ['confetti_ball', '🎊'], ['balloon', '🎈'], ['gift', '🎁'], ['ribbon', '🎀'], ['jack_o_lantern', '🎃'], ['christmas_tree', '🎄'],
    ],
  },
  {
    id: 'objects', label: 'Objects', icon: '💡',
    emojis: [
      ['computer', '💻'], ['desktop', '🖥️'], ['keyboard', '⌨️'], ['mouse_three_button', '🖱️'], ['iphone', '📱'], ['telephone', '☎️'], ['camera', '📷'],
      ['tv', '📺'], ['radio', '📻'], ['bulb', '💡'], ['flashlight', '🔦'], ['candle', '🕯️'], ['moneybag', '💰'], ['gem', '💎'], ['wrench', '🔧'],
      ['hammer', '🔨'], ['tools', '🛠️'], ['gear', '⚙️'], ['link', '🔗'], ['lock', '🔒'], ['unlock', '🔓'], ['key', '🔑'], ['shield', '🛡️'], ['bomb', '💣'],
      ['pill', '💊'], ['books', '📚'], ['book', '📖'], ['pencil', '✏️'], ['memo', '📝'], ['pushpin', '📌'], ['paperclip', '📎'], ['scissors', '✂️'],
      ['calendar', '📅'], ['chart', '📈'], ['clipboard', '📋'], ['package', '📦'], ['envelope', '✉️'], ['bell', '🔔'], ['mega', '📣'], ['hourglass', '⌛'],
      ['alarm_clock', '⏰'], ['rocket', '🚀'], ['airplane', '✈️'], ['car', '🚗'], ['bike', '🚲'], ['house', '🏠'], ['crown', '👑'], ['eyeglasses', '👓'],
    ],
  },
  {
    id: 'symbols', label: 'Symbols', icon: '❤️',
    emojis: [
      ['heart', '❤️'], ['orange_heart', '🧡'], ['yellow_heart', '💛'], ['green_heart', '💚'], ['blue_heart', '💙'], ['purple_heart', '💜'], ['black_heart', '🖤'],
      ['white_heart', '🤍'], ['brown_heart', '🤎'], ['broken_heart', '💔'], ['two_hearts', '💕'], ['sparkling_heart', '💖'], ['heartpulse', '💗'],
      ['100', '💯'], ['anger', '💢'], ['boom', '💥'], ['dizzy', '💫'], ['speech_balloon', '💬'], ['thought_balloon', '💭'], ['zzz', '💤'],
      ['white_check_mark', '✅'], ['x', '❌'], ['warning', '⚠️'], ['no_entry', '⛔'], ['question', '❓'], ['exclamation', '❗'], ['bangbang', '‼️'],
      ['heavy_plus_sign', '➕'], ['heavy_minus_sign', '➖'], ['arrow_right', '➡️'], ['arrow_left', '⬅️'], ['arrow_up', '⬆️'], ['arrow_down', '⬇️'],
      ['recycle', '♻️'], ['infinity', '♾️'], ['red_circle', '🔴'], ['green_circle', '🟢'], ['blue_circle', '🔵'], ['purple_circle', '🟣'], ['new', '🆕'],
      ['free', '🆓'], ['cool', '🆒'], ['ok', '🆗'], ['sos', '🆘'], ['copyright', '©️'], ['tm', '™️'],
    ],
  },
  {
    id: 'flags', label: 'Flags', icon: '🏳️',
    emojis: [
      ['checkered_flag', '🏁'], ['triangular_flag', '🚩'], ['white_flag', '🏳️'], ['black_flag', '🏴'], ['rainbow_flag', '🏳️‍🌈'], ['transgender_flag', '🏳️‍⚧️'],
      ['pirate_flag', '🏴‍☠️'], ['flag_us', '🇺🇸'], ['flag_gb', '🇬🇧'], ['flag_nl', '🇳🇱'], ['flag_de', '🇩🇪'], ['flag_fr', '🇫🇷'], ['flag_es', '🇪🇸'],
      ['flag_it', '🇮🇹'], ['flag_pl', '🇵🇱'], ['flag_be', '🇧🇪'], ['flag_ca', '🇨🇦'], ['flag_br', '🇧🇷'], ['flag_jp', '🇯🇵'], ['flag_kr', '🇰🇷'], ['flag_cn', '🇨🇳'],
      ['flag_in', '🇮🇳'], ['flag_au', '🇦🇺'], ['flag_ua', '🇺🇦'], ['flag_se', '🇸🇪'], ['flag_no', '🇳🇴'], ['flag_fi', '🇫🇮'], ['flag_dk', '🇩🇰'], ['flag_eu', '🇪🇺'],
    ],
  },
];

export const EMOJI_BY_NAME = new Map<string, string>();
for (const c of EMOJI_CATEGORIES) for (const [n, e] of c.emojis) EMOJI_BY_NAME.set(n, e);
EMOJI_BY_NAME.set('+1', '👍');
EMOJI_BY_NAME.set('-1', '👎');
EMOJI_BY_NAME.set('heart_eyes_cat', '😻');

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

export function searchEmoji(q: string, limit = 40): [string, string][] {
  const query = q.toLowerCase();
  const out: [string, string][] = [];
  for (const [n, e] of EMOJI_BY_NAME) {
    if (n.includes(query)) out.push([n, e]);
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => (a[0].startsWith(query) ? 0 : 1) - (b[0].startsWith(query) ? 0 : 1));
}

/** Replaces :shortcodes: with unicode emoji when sending. */
export function replaceShortcodes(text: string) {
  return text.replace(/(^|[^<\w]):([a-z0-9_+-]{1,40}):/g, (m, pre, name) => {
    const e = EMOJI_BY_NAME.get(name);
    return e ? pre + e : m;
  });
}
