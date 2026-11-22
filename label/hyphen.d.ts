/** The German hyphenation patterns of `hyphen` (CommonJS, ships no types). */
declare module "hyphen/de" {
  interface HyphenateOptions {
    hyphenChar?: string;
    minWordLength?: number;
  }
  const de: {
    hyphenateSync(text: string, options?: HyphenateOptions): string;
  };
  export default de;
}
