// Entry point for the standalone Campaign Designer.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DesignerShell } from './DesignerShell';
// THEME FIRST. `theme.css` carries Tailwind plus the agent360 token layer,
// and the two legacy sheets below still bind to the old variable names — so
// the tokens have to be defined before they are read.
import '../designer/theme.css';
import '@fontsource/source-code-pro/400.css';
import '@fontsource/source-code-pro/600.css';
import '../index.css';
import './shell.css';

createRoot(document.getElementById('designer-root')!).render(
  <StrictMode>
    <DesignerShell />
  </StrictMode>,
);
