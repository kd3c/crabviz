/* @refresh reload */
import { render } from 'solid-js/web'

import './index.css'
import App from './App'

const root = document.getElementById('root')
const dot = document.crabvizProps.dot;

render(() => <App {...dot}/>, root)
