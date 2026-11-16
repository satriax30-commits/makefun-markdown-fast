// A fast, dependency-free drop-in for marked 18.1.3 (default options: GFM on,
// breaks off, pedantic off, async off). Written from scratch to match marked's
// HTML byte for byte on every input. No code is copied from marked; the
// CommonMark 0.31.2 and GFM 0.29 grammars it implements are re-expressed here
// in a single-pass design: block scanning builds a small op list (link
// definitions are collected first), then a render pass turns the ops into HTML
// with inline markup rendered straight to a string.
//
// Layout of one op (a small array, first slot is the kind):
//   ['p', raw, text]            paragraph (text = inline source)
//   ['t', raw, text]            bare text block (inside list items, top=false)
//   ['h', depth, text]          heading (ATX or setext)
//   ['code', lang, text]        fenced or indented code block
//   ['hr']                      thematic break
//   ['html', text]              raw HTML block
//   ['bq', ops]                 block quote
//   ['list', ordered, start, loose, items]   items: [task, checked, ops]
//   ['table', aligns, header, rows]          header/rows: arrays of cell texts

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const MULTIPLE_SPACE = /\s+/g;
const NOT_SPACE_START = /^\S*/;

// Escape HTML the way marked does: with encode=true every & < > " ' is
// replaced; otherwise only characters that cannot start a valid reference.
function escapeHtml(html, encode) {
  if (encode) {
    return ESCAPE_TEST.test(html) ? html.replace(ESCAPE_REPLACE, (ch) => ESCAPES[ch]) : html;
  }
  return ESCAPE_TEST_NO_ENCODE.test(html) ? html.replace(ESCAPE_REPLACE_NO_ENCODE, (ch) => ESCAPES[ch]) : html;
}

// Numeric character references stand for the character they name; zero, out
// of range and surrogate values become the replacement character. A bare &
// that cannot start a reference is escaped, and a decoded character must not
// join its neighbours into a new reference.
function decodeNumericRefs(text) {
  if (!NUMERIC_REF.test(text)) return text;
  return text.replace(NUMERIC_REF_OR_AMP, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

const PERCENT_DECODE = /%25/g;
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(PERCENT_DECODE, '%');
  } catch {
    return null;
  }
  return href;
}

// Split a GFM table row on unescaped pipes, honouring the header count.
const FIND_PIPE = /\|/g;
const SPLIT_PIPE = / \|/;
const SLASH_PIPE = /\\\|/g;
function splitCells(tableRow, count) {
  const row = tableRow.replace(FIND_PIPE, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(SPLIT_PIPE);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(SLASH_PIPE, '|');
  return cells;
}

// Remove a trailing run of `c` (or, with invert, of non-`c` characters).
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) suffLen++;
    else if (currChar !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

const BLANK_LINE = /^[ \t]*$/;
function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && BLANK_LINE.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

// A link label, normalised so definitions and references match: surrounding
// whitespace stripped, inner runs collapsed to one space, Unicode case folded
// by round-tripping through upper case (so `ẞ` meets `SS`, as commonmark.js).
function normalizeLabel(label) {
  return label.trim().replace(MULTIPLE_SPACE, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Index of the bracket closing the one opened at level 0, or -1 when there is
// no closer and -2 when the string ends with an unclosed opener.
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

// Expand tabs to the next multiple-of-four column, starting at `indent`.
function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

// Last positions in `src` of a `*` / `_` run and of a `~` run that could close
// emphasis, strong or strikethrough: a run counts only when its predecessor
// is not ASCII whitespace or the start of the string.
function scanLastClosers(src) {
  let star = -1, under = -1, tilde = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') tilde = i;
      else if (ch === '*') star = i;
      else under = i;
    }
    i = j - 1;
  }
  return { star, under, tilde };
}

// ---------------------------------------------------------------------------
// Grammar: the CommonMark 0.31.2 + GFM 0.29 rules, as regular expressions.
// A small composer builds the big patterns from pieces, the way the spec's
// own grammar is written: a name inside a pattern is replaced by the piece
// it stands for (first occurrence for a string name, every occurrence for a
// /g/ regex name), and a stray `^` inside an inserted piece is dropped.
// ---------------------------------------------------------------------------

const CARET = /(^|[^\[])\^/g;
function edit(src, flags) {
  let s = typeof src === 'string' ? src : src.source;
  const api = {
    replace(name, val) {
      let v = typeof val === 'string' ? val : val.source;
      v = v.replace(CARET, '$1');
      s = s.replace(name, v);
      return api;
    },
    re(fl) { return new RegExp(s, fl === undefined ? flags : fl); },
  };
  return api;
}

// A sticky copy of a pattern: the leading `^` is dropped (a sticky `^` only
// matches at index 0) and the `y` flag anchors the match at lastIndex, so
// scanning never copies the remaining string.
function sticky(re, extraFlags) {
  const flags = (re.flags + (extraFlags || '')).replace('g', '') + 'y';
  return new RegExp(re.source.replace(/^\^/, ''), flags);
}

// A sticky copy of a pattern whose alternatives each start with `^` (the
// delimiter and autolink rules): every leading `^` is dropped and the whole
// thing is wrapped, so the `y` flag anchors it at lastIndex.
function stickyAlt(re, extraFlags) {
  const flags = (re.flags + (extraFlags || '')).replace('g', '') + 'y';
  return new RegExp('(?:' + re.source.replace(/(^|\|)\^/g, '$1') + ')', flags);
}

const TAG = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// -- small shared patterns -------------------------------------------------
const CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const OUTPUT_LINK_REPLACE = /\\([\[\]])/g;
const INDENT_CODE_COMPENSATION = /^(\s+)(?:```)/;
const BEGINNING_SPACE = /^\s+/;
const ENDING_HASH = /#$/;
const STARTING_SPACE_CHAR = /^ /;
const ENDING_SPACE_CHAR = / $/;
const ENDING_SPACE_TAB_CHAR = /[ \t]$/;
const NON_SPACE_CHAR = /[^ ]/;
const NEWLINE_GLOBAL = /\n/g;
const TAB_GLOBAL = /\t/g;
const LEADING_SPACE_TAB = /^[ \t]+/;
const BLANK_LINE_RE = /^[ \t]*$/;
const DOUBLE_BLANK_LINE = /\n[ \t]*\n[ \t]*$/;
const BLOCKQUOTE_START = /^ {0,3}>/;
const BLOCKQUOTE_SETEXT_REPLACE = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BLOCKQUOTE_SETEXT_REPLACE2 = /^ {0,3}>[ \t]?/gm;
const BLOCKQUOTE_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const LIST_REPLACE_NESTING = /^ {1,4}(?=( {4})*[^ ])/g;
const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_REPLACE_TASK = /^\[[ xX]\][ \t]+/;
const LIST_TASK_CHECKBOX = /\[[ xX]\]/;
const ANY_LINE = /\n.*\n/;
const HREF_BRACKETS = /^<(.*)>$/;
const TABLE_DELIMITER = /[:|]/;
const TABLE_ALIGN_CHARS = /^\||\| *$/g;
const TABLE_ROW_BLANK_LINE = /\n[ \t]*$/;
const TABLE_ALIGN_RIGHT = /^ *-+: *$/;
const TABLE_ALIGN_CENTER = /^ *:-+: *$/;
const TABLE_ALIGN_LEFT = /^ *:-+ *$/;
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_SCRIPT_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_SCRIPT_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
const START_ANGLE_BRACKET = /^</;
const END_ANGLE_BRACKET = />$/;
const UNICODE_ALPHA_NUMERIC = /[\p{L}\p{N}]/u;
const CARRIAGE_RETURN = /\r\n|\r/g;
const ENDING_NEWLINE = /\n$/;

// Per-indent line-start tests, cached for indents 0..3 (the only ones used).
function cachedIndentRegex(make) {
  const cache = [];
  return (indent) => {
    const i = Math.max(0, Math.min(3, indent - 1));
    return cache[i] || (cache[i] = make(i));
  };
}
const listItemRegex = (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`);
const nextBulletRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`));
const headingBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:</?(?:${TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}>`));

// -- block grammar ---------------------------------------------------------
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const HR_SRC = ' {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_INTERRUPT = ' {0,3}#{1,6}(?:\\s|$)';
const HTML_INTERRUPT = ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';

const blockNewline = /^(?:[ \t]*(?:\n|$))+/;
const blockCode = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const blockFences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const blockHr = new RegExp('^' + HR_SRC);
const blockHeading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const blockText = /^[^\n]+/;
const blockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const blockDef = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', blockLabel)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .re();
const blockList = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, BULLET).re();
const blockHtml = edit(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + ')', 'i')
  .replace('comment', COMMENT)
  .replace('tag', TAG)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .re();

const LHEADING_CORE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const blockLheading = edit(LHEADING_CORE)
  .replace(/bull/g, BULLET)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  // the underline is group 2, so the break alternative must not capture
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .re();

const gfmTable = edit(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', new RegExp(HR_SRC))
  .replace('heading', HEADING_INTERRUPT)
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', HTML_INTERRUPT)
  .replace('tag', TAG)
  .re();

const PARAGRAPH_CORE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function makeParagraph(listInterrupt, tableRepl) {
  return edit(PARAGRAPH_CORE)
    .replace('hr', new RegExp(HR_SRC))
    .replace('heading', HEADING_INTERRUPT)
    .replace('|lheading', '')
    .replace(tableRepl === null ? '|table' : 'table', tableRepl === null ? '' : tableRepl)
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listInterrupt)
    .replace('html', HTML_INTERRUPT)
    .replace('tag', TAG)
    .re();
}
const blockParagraph = makeParagraph(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]', gfmTable);
const blockquoteParagraph = makeParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/, null);
const blockBlockquote = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace('paragraph', blockquoteParagraph).re();

// Sticky copies used by the scanners (no substring copies while scanning).
const sNewline = sticky(blockNewline);
const sBlockCode = sticky(blockCode);
const sFences = sticky(blockFences);
const sHeading = sticky(blockHeading);
const sHr = sticky(blockHr);
const sBlockquote = sticky(blockBlockquote);
const sList = sticky(blockList);
const sHtml = sticky(blockHtml);
const sDef = sticky(blockDef);
const sTable = sticky(gfmTable);
const sLheading = sticky(blockLheading);
const sParagraph = sticky(blockParagraph);
const sBlockText = sticky(blockText);

// -- inline grammar --------------------------------------------------------
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE = /[^\s\p{P}\p{S}]/u;
// GFM treats ~ as a word character inside strong/em, so it is not punctuation there.
const PUNCT_GFM = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;

const inlineEscape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineCode = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const inlineBr = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const inlinePunctuation = edit(/^((?![*_])punctSpace)/, 'u').replace(/punctSpace/g, PUNCT_OR_SPACE).re();

const EM_STRONG_L_CORE = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const inlineEmStrongLDelim = edit(EM_STRONG_L_CORE, 'u').replace(/punct/g, PUNCT_GFM).re();

const EM_STRONG_R_AST_CORE =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // skip an orphan inside strong
  + '|[^*]+(?=[^*])' // consume to the next delimiter
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** closes only
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***# closes only
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a opens only
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# opens only
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# either way
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a either way
const inlineEmStrongRDelimAst = edit(EM_STRONG_R_AST_CORE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_OR_SPACE_GFM)
  .replace(/punctSpace/g, PUNCT_OR_SPACE_GFM)
  .replace(/punct/g, PUNCT_GFM)
  .re();
const EM_STRONG_R_UND_CORE =
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' // skip an orphan inside strong
  + '|[^_]+(?=[^_])' // consume to the next delimiter
  + '|(?!_)punct(_+)(?=[\\s]|$)' // (1) #___ closes only
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)' // (2) a___# closes only
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)' // (3) #___a opens only
  + '|[\\s](_+)(?!_)(?=punct)' // (4) ___# opens only
  + '|(?!_)punct(_+)(?!_)(?=punct)'; // (5) #___# either way; no rule 6 for _
const inlineEmStrongRDelimUnd = edit(EM_STRONG_R_UND_CORE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_OR_SPACE)
  .replace(/punctSpace/g, PUNCT_OR_SPACE)
  .replace(/punct/g, PUNCT)
  .re();

const inlineDelLDelim = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').replace(/punct/g, PUNCT).re();
const DEL_R_CORE =
  '^[^~]+(?=[^~])' // consume to the next delimiter
  + '|(?!~)punct(~~?)(?=[\\s]|$)' // (1) #~~ closes only
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)' // (2) a~~# closes only
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)' // (3) #~~a opens only
  + '|[\\s](~~?)(?!~)(?=punct)' // (4) ~~# opens only
  + '|(?!~)punct(~~?)(?!~)(?=punct)' // (5) #~~# either way
  + '|notPunctSpace(~~?)(?=notPunctSpace)'; // (6) a~~a either way
const inlineDelRDelim = edit(DEL_R_CORE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_OR_SPACE)
  .replace(/punctSpace/g, PUNCT_OR_SPACE)
  .replace(/punct/g, PUNCT)
  .re();
const inlineDel = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

const ANY_PUNCTUATION = edit(/\\(punct)/, 'gu').replace(/punct/g, PUNCT).re();
const ANY_PUNCTUATION_OUTSIDE_CODE = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').replace(/punct/g, PUNCT).re();

const inlineComment = edit(COMMENT).replace('(?:-->|$)', '-->').re();
const inlineTag = edit(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', inlineComment)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .re();

const inlineLabelBrackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const inlineLabel = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', inlineLabelBrackets)
  .re();
const inlineLink = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', inlineLabel)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .re();
const inlineReflink = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', inlineLabel)
  .replace('ref', blockLabel)
  .re();
const inlineNolink = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', blockLabel)
  .re();

const inlineAutolink = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .re();

// One matched pair of brackets, holding no bracket of its own.
const BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', inlineLabelBrackets)
  .re();
const reflinkSearch = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', BOUNDED_INLINE_LABEL)
    .replace('ref', BOUNDED_BLOCK_LABEL)
    .re())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', BOUNDED_BLOCK_LABEL)
    .re())
  .re();

const blockSkip = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .re();

const CASE_INSENSITIVE_PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EXTENDED_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EXTENDED_EMAIL_PROTOCOL = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, EXTENDED_EMAIL)
  .re();
const inlineUrl = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', EXTENDED_EMAIL_PROTOCOL)
  .replace('protocol', CASE_INSENSITIVE_PROTOCOL)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .re();
const BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

const inlineText = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', CASE_INSENSITIVE_PROTOCOL)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
  .re();

// Sticky copies of the anchored inline rules.
const sEscape = sticky(inlineEscape);
const sCode = sticky(inlineCode);
const sBr = sticky(inlineBr);
const sTag = stickyAlt(inlineTag);
const sLink = sticky(inlineLink);
const sReflink = sticky(inlineReflink);
const sNolink = sticky(inlineNolink);
const sEmStrongLDelim = stickyAlt(inlineEmStrongLDelim);
const sDelLDelim = sticky(inlineDelLDelim);
const sAutolink = sticky(inlineAutolink);
const sUrl = stickyAlt(inlineUrl);
const sInlineText = sticky(inlineText);
const sPunctuation = sticky(inlinePunctuation);

// ---------------------------------------------------------------------------
// Block scanning: turns the source into ops and collects link definitions.
// Mirrors marked's block lexer rule order exactly (space, indented code,
// fences, heading, hr, blockquote, list, html, definition, table, setext
// heading, paragraph, text). Inline markup is NOT rendered here: every op
// keeps its raw inline source, and rendering happens after the whole
// document has been scanned, so a definition anywhere in the document can
// serve a reference anywhere else.
// ---------------------------------------------------------------------------

function indentCodeCompensation(raw, text) {
  const m = INDENT_CODE_COMPENSATION.exec(raw);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const n = BEGINNING_SPACE.exec(node);
    if (n === null) return node;
    return node.slice(Math.min(n[0].length, indentToCode.length));
  }).join('\n');
}

// Scan `src` into ops. `links` is the document's definition map (shared, so
// a nested scan registers definitions for the whole document). `st` carries
// the lexer's `top` flag. `clipped` is true when the first paragraph of this
// call continues a paragraph from the caller's token list (blockquote
// continuations). `bag.looseSpacer` is set when a blank-line run of two or
// Is the second line from `pos` a table delimiter row (up to 3 spaces,
// then only `:`, `-`, `|` and spaces, with at least one `-`)? A table can
// only start when it is: the header is one line, the delimiter the second.
function secondLineIsTableDelimiter(src, pos, len) {
  let i = src.indexOf('\n', pos);
  if (i === -1) return false;
  i++;
  let spaces = 0;
  while (i < len && src.charCodeAt(i) === 32) {
    if (++spaces > 3) return false;
    i++;
  }
  let hasDash = false;
  while (i < len) {
    const c = src.charCodeAt(i);
    if (c === 10) break;
    if (c === 45) { hasDash = true; i++; }
    else if (c === 58 || c === 124 || c === 32) i++;
    else return false;
  }
  return hasDash;
}

// Is there a setext underline (up to 3 spaces, then `=`s or `-`s, then
// spaces/tabs) on any line before the next blank line? A setext heading can
// only start when there is one: its paragraph cannot cross a blank line.
function hasSetextUnderline(src, pos, len) {
  let lineStart = pos;
  while (lineStart < len) {
    let i = lineStart;
    let spaces = 0;
    while (i < len && src.charCodeAt(i) === 32) {
      if (++spaces > 3) break;
      i++;
    }
    if (spaces <= 3 && i < len) {
      const c = src.charCodeAt(i);
      if (c === 61 || c === 45) {
        let ok = true;
        let j = i + 1;
        while (j < len) {
          const d = src.charCodeAt(j);
          if (d === 10) break;
          if (d === c || d === 32 || d === 9) j++;
          else { ok = false; break; }
        }
        if (ok) return true;
      }
    }
    // next line; a blank line ends the paragraph
    const nl = src.indexOf('\n', lineStart);
    if (nl === -1) return false;
    lineStart = nl + 1;
    // a blank line (only spaces/tabs) ends the paragraph
    let k = lineStart;
    let blank = true;
    while (k < len) {
      const c = src.charCodeAt(k);
      if (c === 10) break;
      if (c !== 32 && c !== 9) { blank = false; break; }
      k++;
    }
    if (blank) return false;
  }
  return false;
}
function lexBlocks(src, links, st, clipped, bag, ops = []) {
  const len = src.length;
  let pos = 0;
  let remaining = Infinity;

  while (pos < len) {
    const rem = len - pos;
    if (rem >= remaining) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    remaining = rem;

    let m;
    const last = ops.length ? ops[ops.length - 1] : undefined;
    // The first non-space/tab character from here, and whether a tab leads
    // it. Every block rule but indented code and blank lines is
    // `^ {0,3}<first char ...>`, so it can only match when that character is
    // within three spaces and no tab leads it; the regexes below are only
    // run when their first character can match, which skips most of them
    // on an ordinary text line.
    const ch0 = src.charCodeAt(pos);
    let fi = pos;
    let hasTab = false;
    while (fi < len) {
      const c = src.charCodeAt(fi);
      if (c === 32) fi++;
      else if (c === 9) { hasTab = true; fi++; }
      else break;
    }
    const fc = fi < len ? src.charCodeAt(fi) : 0;
    const within3 = !hasTab && fi - pos <= 3;

    // blank lines: a lone newline is folded into the previous op's raw, a
    // longer run is a space op (it renders nothing, but it sits between the
    // blocks, so a following block cannot merge into the one before it)
    if (ch0 === 10 || ch0 === 32 || ch0 === 9) {
    sNewline.lastIndex = pos;
    if ((m = sNewline.exec(src))) {
      const raw = m[0];
      if (raw.length === 1 && last) last.raw += '\n';
      else {
        if (ANY_LINE.test(raw)) bag.looseSpacer = true;
        ops.push({ k: 'space', raw });
      }
      pos += raw.length;
      continue;
    }
    }

    // indented code: cannot interrupt a paragraph, it joins one
    if (ch0 === 32 || ch0 === 9) {
    sBlockCode.lastIndex = pos;
    if ((m = sBlockCode.exec(src))) {
      const raw = trimTrailingBlankLines(m[0]);
      const text = raw.replace(CODE_REMOVE_INDENT, '');
      if (last && (last.k === 'p' || last.k === 't')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
        last.text += '\n' + text;
      } else {
        ops.push({ k: 'code', raw, lang: '', text });
      }
      pos += m[0].length;
      continue;
    }
    }

    // fenced code
    if (within3 && (fc === 96 || fc === 126)) {
    sFences.lastIndex = pos;
    if ((m = sFences.exec(src))) {
      const text = indentCodeCompensation(m[0], m[3] || '');
      ops.push({
        k: 'code',
        raw: m[0],
        lang: m[2] ? m[2].trim().replace(ANY_PUNCTUATION, '$1') : m[2],
        text,
      });
      pos += m[0].length;
      continue;
    }
    }

    // ATX heading
    if (within3 && fc === 35) {
    sHeading.lastIndex = pos;
    if ((m = sHeading.exec(src))) {
      let text = m[2].trim();
      if (ENDING_HASH.test(text)) {
        const trimmed = rtrim(text, '#');
        if (!trimmed || ENDING_SPACE_TAB_CHAR.test(trimmed)) text = trimmed.trim();
      }
      ops.push({ k: 'h', raw: rtrim(m[0], '\n'), depth: m[1].length, text });
      pos += m[0].length;
      continue;
    }
    }

    // thematic break
    if (within3 && (fc === 45 || fc === 95 || fc === 42)) {
    sHr.lastIndex = pos;
    if ((m = sHr.exec(src))) {
      ops.push({ k: 'hr', raw: rtrim(m[0], '\n') });
      pos += m[0].length;
      continue;
    }
    }

    // block quote
    if (within3 && fc === 62) {
    sBlockquote.lastIndex = pos;
    if ((m = sBlockquote.exec(src))) {
      const op = tokenizeBlockquote(m[0], links, st);
      ops.push(op);
      pos += op.raw.length;
      continue;
    }
    }

    // list
    if (within3 && (fc === 42 || fc === 43 || fc === 45 || (fc >= 48 && fc <= 57))) {
    sList.lastIndex = pos;
    if ((m = sList.exec(src))) {
      const op = tokenizeList(src, pos, links, st);
      if (op) {
        ops.push(op);
        pos += op.raw.length;
        continue;
      }
      // no items: not a list after all, fall through to the next rules
    }
    }

    // raw HTML block
    if (within3 && fc === 60) {
    sHtml.lastIndex = pos;
    if ((m = sHtml.exec(src))) {
      const raw = trimTrailingBlankLines(m[0]);
      ops.push({ k: 'html', raw, text: raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style' });
      pos += m[0].length;
      continue;
    }
    }

    // link reference definition
    if (within3 && fc === 91) {
    sDef.lastIndex = pos;
    if ((m = sDef.exec(src))) {
      const raw = rtrim(m[0], '\n');
      // outside angle brackets a destination holds only balanced parentheses
      const valid = START_ANGLE_BRACKET.test(m[2]) || findClosingBracket(m[2], '()') === -1;
      if (valid) {
        if (last && (last.k === 'p' || last.k === 't')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
          last.text += '\n' + raw;
        } else {
          const tag = normalizeLabel(m[1]);
          if (!Object.hasOwn(links, tag)) {
            links[tag] = {
              href: m[2] ? m[2].replace(HREF_BRACKETS, '$1').replace(ANY_PUNCTUATION, '$1') : '',
              title: m[3] ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCTUATION, '$1') : m[3],
            };
          }
          ops.push({ k: 'def', raw });
        }
        pos += m[0].length;
        continue;
      }
      // an unbalanced destination is no definition: fall through
    }
    }

    // GFM table: its delimiter row is always the second line
    if (secondLineIsTableDelimiter(src, pos, len)) {
    sTable.lastIndex = pos;
    if ((m = sTable.exec(src))) {
      if (TABLE_DELIMITER.test(m[2])) {
        const headers = splitCells(m[1]);
        const aligns = m[2].replace(TABLE_ALIGN_CHARS, '').split('|');
        if (headers.length === aligns.length) {
          const align = aligns.map((a) =>
            TABLE_ALIGN_RIGHT.test(a) ? 'right'
            : TABLE_ALIGN_CENTER.test(a) ? 'center'
            : TABLE_ALIGN_LEFT.test(a) ? 'left' : null);
          const rows = m[3] && m[3].trim()
            ? m[3].replace(TABLE_ROW_BLANK_LINE, '').split('\n').map((row) => splitCells(row, headers.length))
            : [];
          ops.push({
            k: 'table',
            raw: rtrim(m[0], '\n'),
            align,
            header: headers,
            rows,
          });
          pos += m[0].length;
          continue;
        }
      }
      // not a table after all: fall through to the setext/paragraph rules
    }
    }

    // setext heading: an underline must appear before a blank line
    if (hasSetextUnderline(src, pos, len)) {
    sLheading.lastIndex = pos;
    if ((m = sLheading.exec(src))) {
      ops.push({ k: 'h', raw: rtrim(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text: m[1].trim() });
      pos += m[0].length;
      continue;
    }
    }

    // paragraph (only at the top level of a scan: inside a list item the
    // same text is a bare text block)
    if (st.top) {
      sParagraph.lastIndex = pos;
      if ((m = sParagraph.exec(src))) {
        const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
        if (clipped && last && last.k === 'p') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + m[0];
          last.text += '\n' + text;
        } else {
          ops.push({ k: 'p', raw: m[0], text });
        }
        clipped = false;
        pos += m[0].length;
        continue;
      }
    }

    // bare text (a line that starts no block)
    sBlockText.lastIndex = pos;
    if ((m = sBlockText.exec(src))) {
      if (last && last.k === 't') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + m[0];
        last.text += '\n' + m[0];
      } else {
        ops.push({ k: 't', raw: m[0], text: m[0] });
      }
      pos += m[0].length;
      continue;
    }

    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }

  st.top = true;
  return ops;
}

// ---------------------------------------------------------------------------
// Block quote and list tokenizers. Both are recursive: a quote's content is
// scanned again as top-level blocks, and a list item's content as blocks with
// `top` off (so its paragraphs stay bare text unless the list is loose).
// ---------------------------------------------------------------------------

function lineAt(src, pos) {
  const nl = src.indexOf('\n', pos);
  return nl === -1 ? src.slice(pos) : src.slice(pos, nl);
}

function tokenizeBlockquoteFromText(text, links, st) {
  sBlockquote.lastIndex = 0;
  const m = sBlockquote.exec(text);
  return m ? tokenizeBlockquote(m[0], links, st) : null;
}

function tokenizeBlockquote(rawMatch, links, st) {
  let lines = rtrim(rawMatch, '\n').split('\n');
  let raw = '';
  let text = '';
  const ops = [];

  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (BLOCKQUOTE_START.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);

    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      // a tab after the marker runs to the next tab stop; the marker only
      // consumes one space of it, the rest is content
      .replace(BLOCKQUOTE_MARKER_WS, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
      // precede a setext continuation with 4 spaces so it is not a setext
      .replace(BLOCKQUOTE_SETEXT_REPLACE, '\n    $1')
      .replace(BLOCKQUOTE_SETEXT_REPLACE2, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;

    // scan the quote's lines as top-level blocks; a paragraph here merges
    // with a paragraph from the previous chunk (a continuation)
    const top = st.top;
    st.top = true;
    lexBlocks(currentText, links, st, true, { looseSpacer: false }, ops);
    st.top = top;

    if (lines.length === 0) break;

    const lastToken = ops.at(-1);
    if (lastToken && (lastToken.k === 'code' || lastToken.k === 'h' || lastToken.k === 'hr' || lastToken.k === 'html' || lastToken.k === 'table')) {
      // a continuation cannot follow a code block, heading, hr, html or table
      break;
    } else if (lastToken && lastToken.k === 'bq') {
      // the continuation belongs to the nested quote: re-scan it whole
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(BLOCKQUOTE_SETEXT_REPLACE2, '');
      const newToken = tokenizeBlockquoteFromText(newText, links, st);
      if (!newToken) break;
      ops[ops.length - 1] = newToken;

      // only the lines the nested quote actually consumed stay in `raw`
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;

      lines = lines.slice(consumed.length);
      // a leftover line starting with '>' still belongs to this quote
      if (lines.length > 0 && BLOCKQUOTE_START.test(lines[0])) continue;
      break;
    } else if (lastToken && lastToken.k === 'list') {
      // the continuation belongs to the nested list: re-scan it whole
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = tokenizeList(newText, 0, links, st);
      if (!newToken) break;
      ops[ops.length - 1] = newToken;

      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = `${raw}\n${consumed}`;
        text = `${text}\n${consumed}`;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }

  return { k: 'bq', raw, text, ops };
}

function tokenizeList(src, pos, links, st) {
  const len = src.length;
  sList.lastIndex = pos;
  const cap0 = sList.exec(src);
  if (!cap0) return null;
  const listStart = pos;
  let cur = pos;

  let bull = cap0[1].trim();
  const isordered = bull.length > 1;
  const list = {
    k: 'list',
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRe = sticky(listItemRegex(bull));
  let endsWithBlankLine = false;

  while (cur < len) {
    let endEarly = false;
    let itemContents = '';
    itemRe.lastIndex = cur;
    const cap = itemRe.exec(src);
    if (!cap) break;

    sHr.lastIndex = cur;
    if (sHr.exec(src)) break; // the bullet was actually a thematic break

    const itemStart = cur;
    cur += cap[0].length;

    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    let line = firstLine.replace(LEADING_SPACE_TAB, (ws) => expandTabs(ws, bulletIndent));
    let nextLine = lineAt(src, cur);
    let blankLine = !line.trim();

    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(NON_SPACE_CHAR);
      indent = indent > 4 ? 1 : indent; // indented code counts as 1 indent
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }

    if (blankLine && BLANK_LINE_RE.test(nextLine)) {
      // an item begins with at most one blank line
      cur += nextLine.length + 1;
      endEarly = true;
    }

    if (!endEarly) {
      const nextBulletRe = nextBulletRegex(indent);
      const hrRe = hrRegex(indent);
      const fencesRe = fencesBeginRegex(indent);
      const headingRe = headingBeginRegex(indent);
      const htmlRe = htmlBeginRegex(indent);
      const bqRe = blockquoteBeginRegex(indent);

      while (cur < len) {
        const rawLine = lineAt(src, cur);
        // Scan the leading whitespace once: `fi` is the index of the first
        // non-space character (-1 for a blank line), `col` its column after
        // expanding tabs to tab stops, `hasTab` whether a tab led it.
        let fi = -1;
        let col = 0;
        let hasTab = false;
        for (let i = 0; i < rawLine.length; i++) {
          const c = rawLine.charCodeAt(i);
          if (c === 32) col++;
          else if (c === 9) { hasTab = true; col += 4 - (col % 4); }
          else { fi = i; break; }
        }
        const nextLine2 = rawLine;
        const nextLineWithoutTabs = hasTab
          ? nextLine2.replace(LEADING_SPACE_TAB, (ws) => expandTabs(ws))
          : nextLine2;
        // Every block-start regex below is `^ {0,indent}<first char ...>`:
        // it can only match when the first non-space character is within
        // `indent` columns, no tab leads it, and it is the pattern's first
        // character. Most lines are plain text, so all six are skipped.
        const fc = fi === -1 ? 0 : rawLine.charCodeAt(fi);
        const canStart = fi !== -1 && fi <= indent && !hasTab;
        if (canStart) {
          if ((fc === 96 || fc === 126) && fencesRe.test(nextLine2)) break;
          if (fc === 35 && headingRe.test(nextLine2)) break;
          if (fc === 60 && htmlRe.test(nextLine2)) break;
          if (fc === 62 && bqRe.test(nextLine2)) break;
          if ((fc === 42 || fc === 43 || fc === 45 || (fc >= 48 && fc <= 57)) && nextBulletRe.test(nextLine2)) break;
          if ((fc === 42 || fc === 45 || fc === 95) && hrRe.test(nextLine2)) break;
        }

        if (fi === -1 || col >= indent) {
          // indented enough: dedent and keep
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          // not enough indentation
          if (blankLine) break;
          // an indented code block ends the item (`line` has no leading
          // tabs, so its first non-space index is its column)
          let lineCol = -1;
          for (let i = 0; i < line.length; i++) {
            if (line.charCodeAt(i) !== 32) { lineCol = i; break; }
          }
          if (lineCol >= 4) break;
          const li = lineCol;
          const lfc = li === -1 ? 0 : line.charCodeAt(li);
          if (li !== -1 && li <= indent) {
            if ((lfc === 96 || lfc === 126) && fencesRe.test(line)) break;
            if (lfc === 35 && headingRe.test(line)) break;
            if (lfc === 60 && htmlRe.test(line)) break;
            if ((lfc === 42 || lfc === 45 || lfc === 95) && hrRe.test(line)) break;
          }

          // a lazy continuation that looks like a setext underline stays in
          // the paragraph, indented so it cannot become one
          const setextContinuation = fi <= 3 && (fc === 61 || fc === 45)
            && /^ {0,3}(?:=+|-+) *$/.test(nextLine2)
            && blockLheading.test(`${line}\n${nextLine2}`);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine2;
          itemContents += '\n' + continuation;
        }

        blankLine = fi === -1;
        cur += rawLine.length + 1;
        line = nextLineWithoutTabs.slice(indent);
      }
    }

    const raw = src.slice(itemStart, cur);
    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (DOUBLE_BLANK_LINE.test(raw)) endsWithBlankLine = true;
    }
    list.items.push({
      task: LIST_IS_TASK.test(itemContents),
      loose: false,
      raw,
      text: itemContents,
      ops: [],
    });
  }

  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return null; // not a list: no items
  }
  list.raw = src.slice(listStart, cur).trimEnd();

  // First pass: scan each item's blocks and settle looseness from spacers.
  for (const item of list.items) {
    st.top = false;
    const bag = { looseSpacer: false };
    item.ops = lexBlocks(item.text, links, st, false, bag);
    if (!list.loose) list.loose = bag.looseSpacer;
  }

  // Second pass: place task checkboxes using the final looseness.
  for (const item of list.items) {
    const itemToken = item.ops[0];
    if (item.task && itemToken && (itemToken.k === 't' || itemToken.k === 'p')) {
      // the marker leaves the item's text; the checkbox is rendered instead
      item.text = item.text.replace(LIST_REPLACE_TASK, '');
      itemToken.raw = itemToken.raw.replace(LIST_REPLACE_TASK, '');
      itemToken.text = itemToken.text.replace(LIST_REPLACE_TASK, '');
      const taskRaw = LIST_TASK_CHECKBOX.exec(item.raw);
      if (taskRaw) {
        const checked = taskRaw[0] !== '[ ]';
        item.checked = checked;
        if (list.loose) {
          // inside the paragraph, before its inline content
          itemToken.cb = checked;
        } else {
          item.ops.unshift({ k: 'checkbox', raw: taskRaw[0] + ' ', checked });
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  // A loose list wraps every item's bare text in paragraphs.
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const op of item.ops) {
        if (op.k === 't') op.k = 'p';
      }
    }
  }

  return list;
}

// ---------------------------------------------------------------------------
// Inline rendering: the loop that turns inline source into HTML (or, with
// `plain`, into plain text for image alt attributes). The order of rules is
// marked's: escape, tag, link, reference link, emphasis/strong, code span,
// hard break, strikethrough, autolink, extended autolink, text. A dispatch
// on the first character skips rules that cannot match there, which is
// equivalent because every rule is anchored on its first character.
// ---------------------------------------------------------------------------

// Does this link text already hold a link? An image does not count: an image
// may hold a link, a link may not.
function linkInText(text, links) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(blockSkip)) {
    if (inlineLink.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1), links)) continue;
    return true;
  }
  return false;
}

// Mask links, code spans, HTML and escapes in `src` so emphasis and
// strikethrough do not see their delimiters inside them. Every mask keeps
// the length it replaces, so indexes line up with `src`.
function maskSrc(src, links) {
  let masked = src;
  if (links && src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      // A candidate holding a link never becomes one, so flattening the
      // whole span would hide the emphasis that still applies inside it.
      // Mask the links it holds instead. Images are exempt.
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text, links)) {
          return '[' + text.replace(reflinkSearch, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    masked = masked.replace(reflinkSearch, maskReflink);
  }
  // Mask escaped characters. A backslash inside a code span is literal, not
  // an escape, so the backticks of a span are masked instead of its escapes.
  // The pattern can only match a backtick or a backslash, so skip the pass
  // when the run holds neither.
  if (masked.includes('`') || masked.includes('\\')) {
    masked = masked.replace(ANY_PUNCTUATION_OUTSIDE_CODE, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }
  // Mask links, code spans and HTML so emphasis does not see delimiters
  // inside them. The pattern can only start on '[', a backtick or '<'.
  if (masked.includes('[') || masked.includes('`') || masked.includes('<')) {
    masked = masked.replace(blockSkip, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }
  return masked;
}

// Is the end of this link label inside an HTML tag or autolink that runs
// past it? Then the label is not a label.
function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = inlineCode.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = inlineTag.exec(tokenSrc) || inlineAutolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// Render one inline link or image (the label has already been matched).
// Returns the HTML and the raw length consumed, or null when the label holds
// a link (links may not contain other links) and this is not an image.
function outputLink(cap, href, title, raw, links, st, plain) {
  const text = cap[1].replace(OUTPUT_LINK_REPLACE, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = st.inLink;
  const outerLinkEmitted = st.linkEmitted;
  const outerInRawBlock = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  // A link's text is its label rendered as HTML; an image's alt is the
  // label rendered as plain text. A link or image nested inside an alt is
  // plain text too.
  const rendered = inlineToString(text, links, st, plain || isImage);
  const textHasLink = st.linkEmitted;
  st.linkEmitted = outerLinkEmitted;
  st.inLink = outerInLink;

  if (!isImage) {
    if (textHasLink) {
      st.inRawBlock = outerInRawBlock;
      return null;
    }
    st.linkEmitted = true;
    if (plain) return { html: rendered, end: raw.length };
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) return { html: rendered, end: raw.length };
    let out = '<a href="' + escapeHtml(cleanHref, false) + '"';
    if (title) out += ' title="' + escapeHtml(title) + '"';
    out += '>' + rendered + '</a>';
    return { html: out, end: raw.length };
  }

  if (plain) return { html: rendered, end: raw.length };
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { html: escapeHtml(rendered), end: raw.length };
  let out = `<img src="${escapeHtml(cleanHref)}" alt="${escapeHtml(rendered)}"`;
  if (title) out += ` title="${escapeHtml(title)}"`;
  out += '>';
  return { html: out, end: raw.length };
}

// Try an inline link `[text](href "title")` or image at `pos` in `src`.
function tryLink(src, pos, links, st, plain) {
  if (st.linkParenPossible === false) return null;
  sLink.lastIndex = pos;
  const cap = sLink.exec(src);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src.slice(pos), cap[1], labelStart)) return null;

  const trimmedUrl = cap[2].trim();
  if (START_ANGLE_BRACKET.test(trimmedUrl)) {
    if (!END_ANGLE_BRACKET.test(trimmedUrl)) return null;
    // the ending angle bracket cannot be escaped
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return null;
    if (lastParenIndex > -1) {
      const start = cap[0].charAt(0) === '!' ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  // the ')' that ends the match is the link closer only when not escaped
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return null;

  let href = cap[2];
  let title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (START_ANGLE_BRACKET.test(href)) href = href.slice(1, -1);
  return outputLink(
    cap,
    href ? href.replace(ANY_PUNCTUATION, '$1') : href,
    title ? title.replace(ANY_PUNCTUATION, '$1') : title,
    cap[0],
    links,
    st,
    plain,
  );
}

// Try a reference link `[text][ref]`, a collapsed one `[ref][]` or a
// shortcut one `[ref]` at `pos`. An unknown label renders its first
// character as plain text.
function tryReflink(src, pos, links, st, plain) {
  sReflink.lastIndex = pos;
  let cap = sReflink.exec(src);
  if (!cap) {
    sNolink.lastIndex = pos;
    cap = sNolink.exec(src);
  }
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src.slice(pos), cap[1], labelStart)) return null;
  const link = links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    return { html: escapeHtml(cap[0].charAt(0)), end: 1 };
  }
  return outputLink(cap, link.href, link.title, cap[0], links, st, plain);
}

// Emphasis and strong emphasis, CommonMark rules 9 and 10 included. `run`
// is the whole inline run being rendered, `pos` the opener's index, and
// `masked` the run's masked source (same length as `run`). `plain` renders
// the inner content as plain text (for image alt attributes).
function tryEmStrong(run, pos, masked, closer, prevChar, links, st, plain) {
  sEmStrongLDelim.lastIndex = pos;
  let match = sEmStrongLDelim.exec(run);
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;

  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = pos;
  let runStart = srcStart;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
  const runPrevChar = runStart > 0 ? [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '' : '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!inlinePunctuation.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!inlinePunctuation.exec(prevChar);

  // `_` cannot open between two alphanumerics
  if (match[4] && prevChar.match(UNICODE_ALPHA_NUMERIC)) return null;

  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;

    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? inlineEmStrongRDelimAst : inlineEmStrongRDelimUnd;
    const lastCloser = delimChar === '*' ? closer.star : closer.under;
    const windowStart = pos + lLength;
    if (lastCloser < windowStart) return null;
    const window = masked.slice(windowStart);
    const lastCloserInWindow = lastCloser - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(window)) !== null) {
      if (match.index > lastCloserInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue; // skip a lone `*` inside `__abc*abc__`
      rLength = [...rDelim].length;

      if (match[3] || match[4]) { // another left delimiter
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) { // either way
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue; // rules 9-10
        }
      }

      delimTotal -= rLength;
      if (delimTotal > 0) continue; // not enough closing delimiters yet

      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = run.slice(pos, pos + lLength + match.index + lastCharLength + rLength);

      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        const inner = inlineToString(text, links, st, plain);
        return { html: plain ? inner : `<em>${inner}</em>`, end: raw.length };
      }
      const text = raw.slice(2, -2);
      const inner = inlineToString(text, links, st, plain);
      return { html: plain ? inner : `<strong>${inner}</strong>`, end: raw.length };
    }
  }
  return null;
}

// Strikethrough `~text~` / `~~text~~`.
function tryDel(run, pos, masked, closer, prevChar, links, st, plain) {
  sDelLDelim.lastIndex = pos;
  let match = sDelLDelim.exec(run);
  if (!match) return null;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || inlinePunctuation.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;
    const endReg = inlineDelRDelim;
    const windowStart = pos + lLength;
    if (closer.tilde < windowStart) return null;
    const window = masked.slice(windowStart);
    const lastCloserInWindow = closer.tilde - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(window)) !== null) {
      if (match.index > lastCloserInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) { // another left delimiter
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = run.slice(pos, pos + lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      const inner = inlineToString(text, links, st, plain);
      return { html: plain ? inner : `<del>${inner}</del>`, end: raw.length };
    }
  }
  return null;
}

// Render one inline run to HTML (`plain` false) or to plain text (true,
// for image alt attributes). `st` is shared across the whole document: it
// carries inLink, inRawBlock and linkEmitted.
function inlineToString(src, links, st, plain) {
  const prevParenPossible = st.linkParenPossible;
  st.linkParenPossible = prevParenPossible && src.includes(')');
  let out = '';
  let pos = 0;
  const len = src.length;
  let keepPrevChar = false;
  let prevChar = '';
  // Lazily built: the masked source and its closer scan, only when an
  // emphasis or strikethrough opener is actually tried.
  let masked = null;
  let closer = null;
  const getMasked = () => {
    if (masked === null) {
      masked = (src.includes('*') || src.includes('_') || src.includes('~')) ? maskSrc(src, links) : src;
      closer = scanLastClosers(masked);
    }
    return masked;
  };

  while (pos < len) {
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    const ch = src[pos];
    let done = false;

    if (ch === '\\') {
      sEscape.lastIndex = pos;
      const m = sEscape.exec(src);
      if (m) {
        out += plain ? m[1] : escapeHtml(m[1]);
        pos += m[0].length;
        done = true;
      } else {
        sBr.lastIndex = pos;
        const br = sBr.exec(src);
        if (br) {
          out += plain ? '' : '<br>';
          pos += br[0].length;
          done = true;
        }
      }
    } else if (ch === '<') {
      sTag.lastIndex = pos;
      const m = sTag.exec(src);
      if (m) {
        if (!st.inLink && START_A_TAG.test(m[0])) st.inLink = true;
        else if (st.inLink && END_A_TAG.test(m[0])) st.inLink = false;
        if (!st.inRawBlock && START_PRE_SCRIPT_TAG.test(m[0])) st.inRawBlock = true;
        else if (st.inRawBlock && END_PRE_SCRIPT_TAG.test(m[0])) st.inRawBlock = false;
        out += m[0];
        pos += m[0].length;
        done = true;
      } else {
        sAutolink.lastIndex = pos;
        const al = sAutolink.exec(src);
        if (al) {
          let text, href;
          if (al[2] === '@') { text = al[1]; href = 'mailto:' + text; }
          else { text = al[1]; href = text; }
          if (plain) {
            out += text;
          } else {
            const cleanHref = cleanUrl(href);
            out += cleanHref === null
              ? escapeHtml(text, true)
              : '<a href="' + escapeHtml(cleanHref, true) + '">' + escapeHtml(text, true) + '</a>';
          }
          // an autolink does not count as a link for the "no nested links"
          // rule: it does not set linkEmitted, so a link label holding one
          // still becomes a link
          pos += al[0].length;
          done = true;
        }
      }
    } else if (ch === '[' || (ch === '!' && src[pos + 1] === '[')) {
      const link = tryLink(src, pos, links, st, plain) || tryReflink(src, pos, links, st, plain);
      if (link) {
        out += link.html;
        pos += link.end;
        done = true;
      }
    } else if (ch === '*' || ch === '_') {
      const em = tryEmStrong(src, pos, getMasked(), closer, prevChar, links, st, plain);
      if (em) {
        out += em.html;
        pos += em.end;
        done = true;
      }
    } else if (ch === '`') {
      sCode.lastIndex = pos;
      const m = sCode.exec(src);
      if (m) {
        let text = m[2].replace(NEWLINE_GLOBAL, ' ');
        const hasNonSpace = NON_SPACE_CHAR.test(text);
        const hasSpaceBothEnds = STARTING_SPACE_CHAR.test(text) && ENDING_SPACE_CHAR.test(text);
        if (hasNonSpace && hasSpaceBothEnds) text = text.substring(1, text.length - 1);
        out += plain ? text : `<code>${escapeHtml(text, true)}</code>`;
        pos += m[0].length;
        done = true;
      }
    } else if (ch === ' ') {
      sBr.lastIndex = pos;
      const br = sBr.exec(src);
      if (br) {
        out += plain ? '' : '<br>';
        pos += br[0].length;
        done = true;
      }
    } else if (ch === '~') {
      const del = tryDel(src, pos, getMasked(), closer, prevChar, links, st, plain);
      if (del) {
        out += del.html;
        pos += del.end;
        done = true;
      }
    } else if (!st.inLink && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'))) {
      sUrl.lastIndex = pos;
      const m = sUrl.exec(src);
      if (m) {
        let text, href;
        if (m[2] === '@') {
          text = m[0];
          href = 'mailto:' + text;
        } else {
          let prevCapZero;
          do {
            prevCapZero = m[0];
            m[0] = BACKPEDAL.exec(m[0])?.[0] ?? '';
          } while (prevCapZero !== m[0]);
          text = m[0];
          href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
        }
        if (plain) {
          out += text;
        } else {
          const cleanHref = cleanUrl(href);
          out += cleanHref === null
            ? escapeHtml(text, true)
            : '<a href="' + escapeHtml(cleanHref, true) + '">' + escapeHtml(text, true) + '</a>';
        }
        // a bare URL does not count as a link for the "no nested links" rule
        pos += m[0].length;
        done = true;
      }
    }

    if (done) continue;

    // plain text: runs until the next character a rule could start on
    sInlineText.lastIndex = pos;
    const t = sInlineText.exec(src);
    if (!t) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    const raw = t[0];
    if (plain) {
      out += st.inRawBlock ? raw : decodeNumericRefs(raw);
    } else {
      out += st.inRawBlock ? raw : escapeHtml(decodeNumericRefs(raw));
    }
    if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
    keepPrevChar = true;
    pos += raw.length;
  }

  st.linkParenPossible = prevParenPossible;
  return out;
}

// ---------------------------------------------------------------------------
// Block rendering: ops to HTML. Inline runs are rendered here, after the
// whole document has been scanned, so every definition is known. Each inline
// run starts with inRawBlock off, as marked resets it between queued runs.
// ---------------------------------------------------------------------------

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function tableCell(text, isHeader, align, links, st) {
  st.inRawBlock = false;
  const content = inlineToString(text, links, st, false);
  const type = isHeader ? 'th' : 'td';
  const tag = align ? `<${type} align="${align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

function renderOps(ops, links, st) {
  let out = '';
  for (const op of ops) {
    switch (op.k) {
      case 'p': {
        st.inRawBlock = false;
        out += '<p>' + (op.cb !== undefined ? checkboxHtml(op.cb) : '')
          + inlineToString(op.text, links, st, false) + '</p>\n';
        break;
      }
      case 't': {
        st.inRawBlock = false;
        out += (op.cb !== undefined ? checkboxHtml(op.cb) : '')
          + inlineToString(op.text, links, st, false);
        break;
      }
      case 'h': {
        st.inRawBlock = false;
        out += `<h${op.depth}>` + inlineToString(op.text, links, st, false) + `</h${op.depth}>\n`;
        break;
      }
      case 'code': {
        const langString = (op.lang || '').match(NOT_SPACE_START)?.[0];
        // An empty code block has no content, so it must not gain a newline.
        const code = op.text ? op.text.replace(ENDING_NEWLINE, '') + '\n' : '';
        if (!langString) {
          out += '<pre><code>' + escapeHtml(code, true) + '</code></pre>\n';
        } else {
          out += '<pre><code class="language-' + escapeHtml(langString) + '">'
            + escapeHtml(code, true) + '</code></pre>\n';
        }
        break;
      }
      case 'hr': {
        out += '<hr>\n';
        break;
      }
      case 'space': {
        // a blank-line run renders nothing
        break;
      }
      case 'html': {
        out += op.text;
        break;
      }
      case 'def': {
        // a definition renders nothing
        break;
      }
      case 'bq': {
        out += `<blockquote>\n${renderOps(op.ops, links, st)}</blockquote>\n`;
        break;
      }
      case 'list': {
        let body = '';
        for (const item of op.items) body += `<li>${renderOps(item.ops, links, st)}</li>\n`;
        const type = op.ordered ? 'ol' : 'ul';
        const startAttr = (op.ordered && op.start !== 1) ? (' start="' + op.start + '"') : '';
        out += '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
        break;
      }
      case 'checkbox': {
        out += checkboxHtml(op.checked);
        break;
      }
      case 'table': {
        let header = '';
        for (let j = 0; j < op.header.length; j++) {
          header += tableCell(op.header[j], true, op.align[j], links, st);
        }
        let body = '';
        for (const row of op.rows) {
          let cell = '';
          for (let k = 0; k < row.length; k++) {
            cell += tableCell(row[k], false, op.align[k], links, st);
          }
          body += `<tr>\n${cell}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += '<table>\n<thead>\n' + `<tr>\n${header}</tr>\n` + '</thead>\n' + body + '</table>\n';
        break;
      }
    }
  }
  return out;
}

// The HTML marked 18.1.3 renders for `markdown`, with its default options
// (GFM on, breaks off, pedantic off, async off). Every call is independent:
// nothing is kept from an earlier call, and the result depends only on the
// string given here.
export function parse(markdown) {
  const src = markdown.replace(CARRIAGE_RETURN, '\n');
  const links = Object.create(null);
  const st = { top: true, inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true };
  const ops = lexBlocks(src, links, st, false, { looseSpacer: false });
  return renderOps(ops, links, st);
}
