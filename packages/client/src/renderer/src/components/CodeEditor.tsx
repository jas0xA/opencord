import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';

/** CodeMirror 6 editor with syntax highlighting, autocomplete, bracket matching, search and folding. */
export function CodeEditor({ value, onChange, language, readOnly }: { value: string; onChange?: (v: string) => void; language: 'css' | 'js'; readOnly?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          language === 'css' ? css() : javascript(),
          oneDark,
          EditorState.readOnly.of(!!readOnly),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          }),
          EditorView.theme({ '&': { height: '100%', fontSize: '13px' }, '.cm-scroller': { fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, monospace' } }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // Recreate only when the language or read-only mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly]);

  // Accept external value changes (e.g. "insert template") without losing the cursor on normal typing.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} className="code-editor" />;
}
