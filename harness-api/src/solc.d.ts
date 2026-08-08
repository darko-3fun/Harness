declare module 'solc' {
  interface CompileCallbacks {
    import?: (path: string) => { contents: string } | { error: string };
  }
  const solc: {
    version(): string;
    compile(input: string, callbacks?: CompileCallbacks): string;
  };
  export default solc;
}
