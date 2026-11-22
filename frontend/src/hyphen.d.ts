/** The German hyphenation patterns of `hyphen` (CommonJS, ships no types). The file path, not the directory: Node refuses a directory import from ES modules. */
declare module "hyphen/de/index.js" {
  interface HyphenateOptions {
    hyphenChar?: string;
    minWordLength?: number;
  }
  const de: {
    hyphenateSync(text: string, options?: HyphenateOptions): string;
  };
  export default de;
}
