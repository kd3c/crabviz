/* @refresh reload */
import { render } from 'solid-js/web';

import './index.css';
import App from './App';

const root = document.getElementById('root');
const props = document.crabvizProps;

render(() => <App {...props} />, root);
