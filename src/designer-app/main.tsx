// Entry point for the standalone Campaign Designer.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DesignerShell } from './DesignerShell';
import '../index.css';
import './shell.css';

createRoot(document.getElementById('designer-root')!).render(
  <StrictMode>
    <DesignerShell />
  </StrictMode>,
);
