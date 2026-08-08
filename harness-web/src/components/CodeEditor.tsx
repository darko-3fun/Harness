'use client';

import CodeMirror from '@uiw/react-codemirror';
import { solidity } from '@replit/codemirror-lang-solidity';
import { oneDark } from '@codemirror/theme-one-dark';

/**
 * `solidity` is a LanguageSupport value, not a factory — `solidity()` throws.
 * This component is always loaded through `dynamic(..., { ssr: false })`:
 * CodeMirror's EditorView constructor touches `document` and dies on the server.
 */
export default function CodeEditor({
  value,
  onChange,
  readOnly = false,
}: {
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
}) {
  return (
    <CodeMirror
      value={value}
      height="calc(100vh - 190px)"
      theme={oneDark}
      extensions={[solidity]}
      editable={!readOnly}
      onChange={onChange}
      basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: !readOnly }}
    />
  );
}
