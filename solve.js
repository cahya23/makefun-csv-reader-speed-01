// A fast drop-in for csv-reader 1.0.0: run(input) returns exactly what
// csv-reader 1.0.0 returns for {text, header} — {columns, rows, errors} —
// but reads the text with indexOf jumps and slices instead of one
// character at a time.
//
// How it stays identical:
// - A U+FEFF at the very start is dropped; a record ends at LF or CRLF;
//   a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (stray_cr) and the
//   line is NOT advanced for it.
// - A field opening with a quote runs to the next quote that is not
//   doubled ("" inside is one quote; each CRLF or lone CR inside reads as
//   LF and advances the line once); what follows the closing quote up to
//   the next comma or line break is appended as-is (quote_junk, when the
//   field ends and anything was added); a quote that never closes is a
//   literal character and the text after it is re-read as unquoted
//   (unterminated_quote, with the line reset to the opening quote's line).
// - A quote inside an unquoted field is literal; fields stay strings.
// - columns is the first record when header is true, else null ([] when
//   header is true and there are no records at all); every later record is
//   padded with "" (short_row, with fields: its count) or cut (long_row,
//   with extra: the cut fields) to the first record's width.
// - Every error is {code, line, row} in the order met; line is the
//   1-based line the record starts on, row is the record's index in rows
//   (null for the header); a record's short_row/long_row is reported when
//   the record ends, a field's quote_junk when the field ends.
// - A line holding only stray CRs is no record (its stray_cr errors stay).
// - Pure: nothing is kept from one call to the next.
//
// How it gets fast:
// - Most records hold no quote at all, so a whole record is taken in one
//   go: find its line end, split it on commas with indexOf, and only fall
//   back to the field-by-field reader when a quote (or a stray CR) shows up.
// - Unquoted fields are sliced between their terminators instead of being
//   built a character at a time; quoted fields are sliced between quotes.
// - Error objects are only built when an error actually happens, and the
//   hot path makes no function calls and uses no regular expressions.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// Normalise one quoted-field segment: CRLF and lone CR each become one LF.
// Returns [text, lineBreaks]: the segment as it reads inside quotes, and
// how many lines it advances (one per LF, plus one per lone CR — a CRLF
// pair counts once, which is exactly the LF count after normalising).
function quotedSegment(seg) {
  if (seg.indexOf('\r') === -1) {
    let breaks = 0;
    let at = -1;
    while ((at = seg.indexOf('\n', at + 1)) !== -1) breaks++;
    return [seg, breaks];
  }
  const norm = seg.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  let breaks = 0;
  let at = -1;
  while ((at = norm.indexOf('\n', at + 1)) !== -1) breaks++;
  return [norm, breaks];
}

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and its index in rows
  // (null while the header is still unread).
  let recLine = 1;
  let recRow = null;

  // Read an unquoted field starting at pos, onto `init`. Stops at a comma
  // (COMMA), at a line break (LINE_BREAK, advancing the line) or at the
  // end of the text (END). A CR not followed by LF is dropped and reported
  // as stray_cr, and reading carries on. Returns {v, end, added}: the
  // field, how it ended, and how many characters the scan itself added
  // (the initial value does not count).
  function scanUnquoted(init) {
    let v = init;
    let parts = null;
    let added = 0;
    for (;;) {
      const c = text.indexOf(',', pos);
      const l = text.indexOf('\n', pos);
      let e;
      let end;
      if (c === -1 && l === -1) {
        e = n;
        end = END;
      } else if (c === -1) {
        e = l;
        end = LINE_BREAK;
      } else if (l === -1) {
        e = c;
        end = COMMA;
      } else if (c < l) {
        e = c;
        end = COMMA;
      } else {
        e = l;
        end = LINE_BREAK;
      }
      const seg = text.slice(pos, e);
      const r = seg.indexOf('\r');
      if (r === -1) {
        if (parts === null) v += seg;
        else parts.push(seg);
        added += seg.length;
        if (end === COMMA) pos = e + 1;
        else if (end === LINE_BREAK) {
          pos = e + 1;
          line++;
        } else {
          pos = n;
        }
        return { v: parts === null ? v : parts.join(''), end, added };
      }
      if (text.charCodeAt(pos + r + 1) === 10) {
        // A CRLF inside the field ends it (and the record) here.
        const head = seg.slice(0, r);
        if (parts === null) v += head;
        else parts.push(head);
        added += head.length;
        pos = pos + r + 2;
        line++;
        return { v: parts === null ? v : parts.join(''), end: LINE_BREAK, added };
      }
      // A lone CR: drop it, report it, keep reading after it.
      errors.push({ code: 'stray_cr', line: recLine, row: recRow });
      const head = seg.slice(0, r);
      if (parts === null) parts = [v, head];
      else parts.push(head);
      added += head.length;
      pos = pos + r + 1;
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const cc = text.charCodeAt(pos);
      if (cc === 10) {
        pos++;
        line++;
      } else if (cc === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recLine = line;
    recRow = header && columns === null ? null : rows.length;
    const recPos = pos;

    // Fast path: the record's line holds no quote, so no field on it can
    // open quoted and no quoted field can span past it. Split it on
    // commas; a stray CR anywhere in it sends the record to the slow path.
    const lineEnd = text.indexOf('\n', pos);
    const segEnd = lineEnd === -1 ? n : lineEnd;
    const qAt = text.indexOf('"', pos);
    if (qAt === -1 || qAt >= segEnd) {
      let effEnd = segEnd;
      if (lineEnd !== -1 && effEnd > pos && text.charCodeAt(effEnd - 1) === 13) effEnd--;
      const fields = [];
      let fp = pos;
      let badCR = false;
      for (;;) {
        const cm = text.indexOf(',', fp);
        if (cm === -1 || cm >= effEnd) {
          const f = text.slice(fp, effEnd);
          if (f.indexOf('\r') !== -1) badCR = true;
          else fields.push(f);
          break;
        }
        const f = text.slice(fp, cm);
        if (f.indexOf('\r') !== -1) {
          badCR = true;
          break;
        }
        fields.push(f);
        fp = cm + 1;
      }
      if (!badCR) {
        pos = lineEnd === -1 ? n : lineEnd + 1;
        if (lineEnd !== -1) line++;
        if (width < 0) width = fields.length;
        if (header && columns === null) {
          columns = fields;
        } else {
          if (fields.length < width) {
            errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
            while (fields.length < width) fields.push('');
          } else if (fields.length > width) {
            errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
          }
          rows.push(fields);
        }
        continue;
      }
      pos = recPos;
      line = recLine;
    }

    // Slow path: field by field, for records holding a quote or a stray CR.
    const fields = [];
    let lastQuoted = false;
    for (;;) {
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        const open = pos;
        const openLine = line;
        let qv = '';
        let qp = null;
        let p = pos + 1;
        let closedAt = -1;
        for (;;) {
          const q = text.indexOf('"', p);
          if (q === -1) break;
          if (text.charCodeAt(q + 1) === 34) {
            // A doubled quote: the segment before it, then one quote.
            const seg = quotedSegment(text.slice(p, q));
            line += seg[1];
            if (qp === null) qv += seg[0];
            else qp.push(seg[0]);
            if (qp === null) qv += '"';
            else qp.push('"');
            p = q + 2;
            continue;
          }
          const seg = quotedSegment(text.slice(p, q));
          line += seg[1];
          if (qp === null) qv += seg[0];
          else qp.push(seg[0]);
          closedAt = q;
          break;
        }
        if (closedAt === -1) {
          // The quote never closes: it is a literal character, and the
          // text after it is read again as unquoted, from the opening
          // quote's line.
          errors.push({ code: 'unterminated_quote', line: recLine, row: recRow });
          pos = open + 1;
          line = openLine;
          const u = scanUnquoted('"');
          fields.push(u.v);
          if (u.end === COMMA) continue;
          break;
        }
        const value = qp === null ? qv : qp.join('');
        pos = closedAt + 1;
        if (pos >= n) {
          fields.push(value);
          break;
        }
        const cc = text.charCodeAt(pos);
        if (cc === 44) {
          pos++;
          fields.push(value);
          continue;
        }
        if (cc === 10) {
          pos++;
          line++;
          fields.push(value);
          break;
        }
        if (cc === 13 && text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line++;
          fields.push(value);
          break;
        }
        // What follows the closing quote is appended as it stands, up to
        // the next comma or line break.
        const junk = scanUnquoted(value);
        if (junk.added > 0) errors.push({ code: 'quote_junk', line: recLine, row: recRow });
        fields.push(junk.v);
        if (junk.end === COMMA) continue;
        break;
      }
      lastQuoted = false;
      const u = scanUnquoted('');
      fields.push(u.v);
      if (u.end === COMMA) continue;
      break;
    }

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
