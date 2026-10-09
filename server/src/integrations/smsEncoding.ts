/**
 * How many text-message segments a body costs, and why.
 *
 * A text is sent as GSM-7 (160 characters per segment; 153 when it spans several) unless it
 * contains any character outside that alphabet — one em dash is enough — in which case the WHOLE
 * message goes as UCS-2 (70 per segment; 67 when it spans several). Characters from the GSM
 * "extension table" ( ^ { } \\ [ ~ ] | € ) count double.
 */

const GSM_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENSION = '^{}\\[~]|€';

export interface SmsInfo {
  length: number;
  encoding: 'GSM-7' | 'UCS-2';
  segments: number;
  /** Characters that force UCS-2 (empty for GSM-7). */
  nonGsm: string[];
}

export function smsInfo(text: string): SmsInfo {
  const chars = [...text];
  const nonGsm = [...new Set(chars.filter((c) => !GSM_BASIC.includes(c) && !GSM_EXTENSION.includes(c)))];
  if (nonGsm.length === 0) {
    const length = chars.reduce((n, c) => n + (GSM_EXTENSION.includes(c) ? 2 : 1), 0);
    return { length, encoding: 'GSM-7', segments: length <= 160 ? 1 : Math.ceil(length / 153), nonGsm };
  }
  const length = text.length; // UTF-16 code units, which is what UCS-2 counts
  return { length, encoding: 'UCS-2', segments: length <= 70 ? 1 : Math.ceil(length / 67), nonGsm };
}
