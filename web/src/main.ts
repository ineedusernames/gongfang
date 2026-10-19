import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { installKeyboardFit } from './lib/keyboard';

const root = document.getElementById('app')!;
installKeyboardFit(root);

export default mount(App, { target: root });
