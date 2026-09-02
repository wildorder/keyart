import * as readline from "node:readline/promises";

export interface WizardIO {
  /** Print `prompt` and resolve with the user's raw line (without trailing newline). */
  question(prompt: string): Promise<string>;
  /** Release any underlying resources (e.g. the readline interface). Idempotent. */
  close(): void;
}

/** Real IO backed by node:readline/promises over process.stdin/process.stdout. */
export function createReadlineIO(): WizardIO {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let closed = false;
  return {
    question(prompt: string): Promise<string> {
      return rl.question(prompt);
    },
    close(): void {
      if (closed) return;
      closed = true;
      rl.close();
    },
  };
}

/** Ask a free-text question with a default shown in brackets; empty answer → default. */
export async function askDefault(
  io: WizardIO,
  label: string,
  defaultValue: string,
): Promise<string> {
  const answer = (await io.question(`${label} [${defaultValue}]: `)).trim();
  return answer === "" ? defaultValue : answer;
}

/** Ask a yes/no question; empty answer → `defaultYes`. Accepts y/yes/n/no (case-insensitive). */
export async function askYesNo(
  io: WizardIO,
  label: string,
  defaultYes: boolean,
): Promise<boolean> {
  const suffix = defaultYes ? "Y/n" : "y/N";
  const answer = (await io.question(`${label} [${suffix}]: `))
    .trim()
    .toLowerCase();
  if (answer === "") return defaultYes;
  if (answer === "y" || answer === "yes") return true;
  if (answer === "n" || answer === "no") return false;
  return defaultYes;
}

/**
 * Ask the user to pick one of `choices` (numbered from 1). Empty answer →
 * choices[defaultIndex] (default 0). Accepts a 1-based number OR an exact
 * (case-insensitive) choice value. Re-prompts on invalid input.
 */
export async function askChoice(
  io: WizardIO,
  label: string,
  choices: string[],
  defaultIndex = 0,
): Promise<string> {
  const menu = choices.map((choice, i) => `  ${i + 1}) ${choice}`).join("\n");
  let prefix = "";

  for (;;) {
    const answer = (
      await io.question(`${prefix}${menu}\n${label} [${defaultIndex + 1}]: `)
    ).trim();

    if (answer === "") return choices[defaultIndex];

    const asNumber = Number(answer);
    if (
      Number.isInteger(asNumber) &&
      asNumber >= 1 &&
      asNumber <= choices.length
    ) {
      return choices[asNumber - 1];
    }

    const matched = choices.find(
      (choice) => choice.toLowerCase() === answer.toLowerCase(),
    );
    if (matched !== undefined) return matched;

    prefix = `Please choose 1-${choices.length}.\n`;
  }
}
