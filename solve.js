// A fast drop-in replacement for csv-reader 1.0.0 (make.fun's reference CSV reader).
//
// run(input) returns exactly what csv-reader 1.0.0 returns for input {text, header}: the JSON value
// {columns, rows, errors}, with csv-reader's broken-row policy:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled ("" inside it is one quote;
//     each CRLF or lone CR inside it is read as LF); what follows its closing quote, up to the next comma or
//     line break, is appended as it stands (error quote_junk, when the field ends, if anything was appended);
//   - a quote that never closes is a literal character and the text after it is read again as unquoted
//     (error unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed;
//   - columns is the first record when header is true, else null; rows holds the records after it (every
//     record when header is false), each padded with "" (error short_row, with fields: its field count) or
//     cut (error long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on (counting every LF, CRLF
//     and lone CR inside quotes), row its record's index in rows (null for the header), in the order met.
//
// Speed: one left-to-right pass. The common stretches (an unquoted field, the inside of a quoted field) are
// crossed with String#indexOf, which scans natively, and a field's characters are taken with one slice, not
// built up a character at a time. The next CR and next LF positions are cached and only move forward, so a
// file whose CRs are rare never pays for rescanning them. Nothing is kept from one call to the next.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Monotonic caches: crPos / lfPos hold the index of the next CR / LF at or after the position they were
  // computed from (n when there is none, -2 when stale). ensure* recomputes one only once pos has passed it,
  // so over a whole parse each cache's scans together cross the text about once.
  let crPos = -2;
  let lfPos = -2;

  function ensureCr() {
    if (crPos < pos) {
      crPos = text.indexOf('\r', pos);
      if (crPos === -1) crPos = n;
    }
  }

  function ensureLf() {
    if (lfPos < pos) {
      lfPos = text.indexOf('\n', pos);
      if (lfPos === -1) lfPos = n;
    }
  }

  // How the last field read ended, and how many characters the last readUnquoted call kept (dropped CRs not
  // counted): the caller after a quoted field needs the count to decide quote_junk.
  let fEnded = END;
  let fAdded = 0;

  // Reads unquoted characters from pos onto `initial` (the value so far: '' for a plain field, '"' for the
  // re-read of an unterminated quote, the quoted content for quote junk) up to the next comma or line break.
  // A CR not followed by LF is dropped (stray_cr). Sets fEnded and fAdded; returns the field's value.
  function readUnquoted(initial) {
    let parts = null; // the kept segments, when a stray CR split the field (or to join onto `initial`)
    let segStart = pos;
    fAdded = 0;
    for (;;) {
      ensureCr();
      ensureLf();
      const ci = text.indexOf(',', pos);
      const commaPos = ci === -1 ? n : ci;
      const end = commaPos < lfPos ? commaPos : lfPos;
      if (crPos < end) {
        if (text.charCodeAt(crPos + 1) === 10) {
          // A CRLF ends the field (then end is that LF: crPos + 1).
          if (segStart < crPos) {
            const s = text.slice(segStart, crPos);
            if (parts === null) parts = [s]; else parts.push(s);
            fAdded += crPos - segStart;
          }
          pos = crPos + 2;
          line += 1;
          crPos = -2;
          lfPos = -2;
          fEnded = LINE_BREAK;
          break;
        }
        // A stray CR: drop it, keep the segment before it, read on.
        if (segStart < crPos) {
          const s = text.slice(segStart, crPos);
          if (parts === null) parts = [s]; else parts.push(s);
          fAdded += crPos - segStart;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos = crPos + 1;
        crPos = -2;
        segStart = pos;
        continue;
      }
      if (segStart < end) {
        const s = text.slice(segStart, end);
        if (parts === null) parts = [s]; else parts.push(s);
        fAdded += end - segStart;
      }
      if (end === n) {
        pos = n;
        fEnded = END;
      } else if (end === commaPos) {
        pos = end + 1;
        fEnded = COMMA;
      } else {
        pos = end + 1;
        line += 1;
        lfPos = -2;
        fEnded = LINE_BREAK;
      }
      break;
    }
    if (parts === null) return initial;
    if (initial === '') return parts.length === 1 ? parts[0] : parts.join('');
    return initial + parts.join('');
  }

  // Reads a quoted field whose opening quote is at pos. Sets fEnded; returns the field's value.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let parts = null; // the kept segments of the quoted content, split at doubled quotes
    let segStart = pos;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        crPos = -2;
        lfPos = -2;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      if (segStart < q) {
        ensureCr();
        ensureLf();
        if (crPos < q) {
          // A CR inside this segment: each CRLF or lone CR is read as LF. Rebuild the segment (rare).
          let buf = '';
          for (let i = segStart; i < q; i++) {
            const c = text.charCodeAt(i);
            if (c === 13) {
              buf += '\n';
              line += 1;
              if (text.charCodeAt(i + 1) === 10) i += 1;
            } else {
              if (c === 10) line += 1;
              buf += text[i];
            }
          }
          if (parts === null) parts = [buf]; else parts.push(buf);
          crPos = -2;
          lfPos = -2;
        } else if (lfPos < q) {
          // Line breaks inside, but no CR: the characters stand as they are; only the line count moves.
          const s = text.slice(segStart, q);
          if (parts === null) parts = [s]; else parts.push(s);
          while (lfPos < q) {
            line += 1;
            const nx = text.indexOf('\n', lfPos + 1);
            lfPos = nx === -1 ? n : nx;
          }
        } else {
          const s = text.slice(segStart, q);
          if (parts === null) parts = [s]; else parts.push(s);
        }
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one quote of content, and the field goes on.
        if (parts === null) parts = ['"']; else parts.push('"');
        pos = q + 2;
        segStart = pos;
        continue;
      }
      // The closing quote.
      pos = q + 1;
      const value = parts === null ? '' : parts.join('');
      if (pos >= n) {
        fEnded = END;
        return value;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fEnded = COMMA;
        return value;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        lfPos = -2;
        fEnded = LINE_BREAK;
        return value;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        crPos = -2;
        lfPos = -2;
        fEnded = LINE_BREAK;
        return value;
      }
      // What follows the closing quote is appended as it stands, up to the next comma or line break.
      const v = readUnquoted(value);
      if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return v;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    do {
      lastQuoted = text.charCodeAt(pos) === 34;
      fields.push(lastQuoted ? readQuoted() : readUnquoted(''));
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
