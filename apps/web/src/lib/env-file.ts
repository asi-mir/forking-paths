/**
 * Edits one variable in a dotenv file's text and leaves every other line as it was
 * (scripts only: `design-voice.ts --write-env`). It never reads values back out.
 */

/** An env value that dotenv reads back as written: letters, digits and `_ - . : /` only. */
export function isPlainEnvValue(value: string): boolean {
  return /^[A-Za-z0-9_\-.:/]+$/.test(value);
}

/**
 * Sets `name=value` in `content`: replaces the first `name=` line (also a commented
 * `# name=` line when there is no live one) and drops later duplicates; appends the line
 * when the file has none.
 */
export function setEnvLine(content: string, name: string, value: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`not an env name: ${name}`);
  if (!isPlainEnvValue(value)) throw new Error(`refusing an env value with unusual characters for ${name}`);
  const live = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`);
  const commented = new RegExp(`^\\s*#\\s*${name}\\s*=`);
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.length ? content.split(/\r?\n/) : [];
  const line = `${name}=${value}`;

  let done = false;
  const out: string[] = [];
  for (const l of lines) {
    if (live.test(l)) {
      if (!done) out.push(line);
      done = true;
    } else {
      out.push(l);
    }
  }
  if (!done) {
    const i = out.findIndex((l) => commented.test(l));
    if (i >= 0) {
      out[i] = line;
    } else {
      if (out.length && out.at(-1) === "") out.pop();
      out.push(line, "");
    }
  }
  return out.join(eol);
}
