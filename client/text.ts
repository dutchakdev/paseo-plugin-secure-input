/** Which of three forms a count takes in Ukrainian: 1, 21, 101 take the first; 2-4, 22-24 the second; the rest, and 11-14, the third. */
function formFor<Form>(count: number, one: Form, few: Form, many: Form): Form {
  const tens = count % 100;
  const units = count % 10;
  if (units === 1 && tens !== 11) return one;
  if (units >= 2 && units <= 4 && (tens < 12 || tens > 14)) return few;
  return many;
}

/** Ukrainian plural: the count and the form of the noun that goes with it. */
export function plural(count: number, one: string, few: string, many: string): string {
  return `${count} ${formFor(count, one, few, many)}`;
}

/** «1 байт», «2 байти», «5 байтів»: wherever a size is shown, it is said this way. */
export function bytesText(count: number): string {
  return plural(count, "байт", "байти", "байтів");
}

/** One to ten of something feminine, as it is said: «три спроби», and «після трьох спроб». A number past the list is written in digits. */
const FEMININE_COUNT: ReadonlyArray<{ nominative: string; genitive: string }> = [
  { nominative: "одна", genitive: "однієї" },
  { nominative: "дві", genitive: "двох" },
  { nominative: "три", genitive: "трьох" },
  { nominative: "чотири", genitive: "чотирьох" },
  { nominative: "п'ять", genitive: "п'яти" },
  { nominative: "шість", genitive: "шести" },
  { nominative: "сім", genitive: "семи" },
  { nominative: "вісім", genitive: "восьми" },
  { nominative: "дев'ять", genitive: "дев'яти" },
  { nominative: "десять", genitive: "десяти" },
];

/**
 * «Три спроби не вдались»: how many attempts failed, as the start of a sentence. The number is the limit the plugin
 * counts to (`MAX_RETRIES`), so the sentence is built from it and cannot say another number than the plugin means.
 */
export function attemptsFailed(count: number): string {
  const word = FEMININE_COUNT[count - 1]?.nominative ?? String(count);
  return `${word.charAt(0).toUpperCase()}${word.slice(1)} ${formFor(count, "спроба не вдалась", "спроби не вдались", "спроб не вдалось")}`;
}

/** «Після трьох невдалих спроб»: after how many failed attempts something happens. */
export function afterFailedAttempts(count: number): string {
  const word = FEMININE_COUNT[count - 1]?.genitive ?? String(count);
  return `Після ${word} ${formFor(count, "невдалої спроби", "невдалих спроб", "невдалих спроб")}`;
}
