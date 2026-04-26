import { useMemo, type Ref } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { yaml } from '@codemirror/lang-yaml';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { EditorView, keymap } from '@codemirror/view';

type ConfigSourceEditorProps = {
  value: string;
  onChange: (value: string) => void;
  editorRef?: Ref<ReactCodeMirrorRef>;
  theme: 'light' | 'dark';
  editable: boolean;
  placeholder: string;
};

const sourceHighlightTheme = (theme: 'light' | 'dark') => {
  const isDark = theme === 'dark';

  return EditorView.theme({
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: isDark ? 'rgba(120, 153, 255, 0.38)' : 'rgba(37, 99, 235, 0.22)',
    },
    '.cm-activeLine': {
      backgroundColor: isDark ? 'rgba(255, 255, 255, 0.075)' : 'rgba(37, 99, 235, 0.075)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: isDark ? 'rgba(255, 255, 255, 0.09)' : 'rgba(37, 99, 235, 0.1)',
      color: isDark ? '#e5e7eb' : '#1f2937',
    },
    '.cm-selectionMatch': {
      backgroundColor: isDark ? 'rgba(250, 204, 21, 0.24)' : 'rgba(250, 204, 21, 0.32)',
    },
    '.cm-searchMatch': {
      backgroundColor: isDark ? 'rgba(250, 204, 21, 0.34)' : 'rgba(250, 204, 21, 0.42)',
      outline: isDark
        ? '1px solid rgba(250, 204, 21, 0.5)'
        : '1px solid rgba(217, 119, 6, 0.45)',
    },
    '.cm-searchMatch-selected': {
      backgroundColor: isDark ? 'rgba(251, 146, 60, 0.42)' : 'rgba(249, 115, 22, 0.42)',
    },
  });
};

export default function ConfigSourceEditor({
  value,
  onChange,
  editorRef,
  theme,
  editable,
  placeholder,
}: ConfigSourceEditorProps) {
  const extensions = useMemo(
    () => [
      yaml(),
      search(),
      highlightSelectionMatches(),
      keymap.of(searchKeymap),
      sourceHighlightTheme(theme),
    ],
    [theme]
  );

  return (
    <CodeMirror
      ref={editorRef}
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={theme}
      editable={editable}
      placeholder={placeholder}
      height="100%"
      style={{ height: '100%' }}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLineGutter: true,
        highlightActiveLine: true,
        foldGutter: true,
        dropCursor: true,
        allowMultipleSelections: true,
        indentOnInput: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: false,
        rectangularSelection: true,
        crosshairCursor: false,
        highlightSelectionMatches: true,
        closeBracketsKeymap: true,
        searchKeymap: true,
        foldKeymap: true,
        completionKeymap: false,
        lintKeymap: true,
      }}
    />
  );
}
