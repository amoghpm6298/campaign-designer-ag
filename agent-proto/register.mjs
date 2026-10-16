// Entry hook for the evaluation runner. See tsResolve.mjs.
import { register } from 'node:module';
register('./tsResolve.mjs', import.meta.url);
