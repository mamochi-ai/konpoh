import { render } from 'preact';
import { App } from './ui/App';
import { init } from './app/store';
import './styles.css';

render(<App />, document.getElementById('root')!);
init();
