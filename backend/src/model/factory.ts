import type { Config } from '../config.js';
import { ModalModelProvider } from './modal.js';
import { OllamaModelProvider } from './ollama.js';
import { FakeModelProvider, type ModelProvider } from './provider.js';

/** Build the configured model provider. Defaults to a deterministic fake. */
export function createModelProvider(config: Config): ModelProvider {
  switch (config.MODEL_PROVIDER) {
    case 'ollama':
      return new OllamaModelProvider(config.OLLAMA_URL, config.MODEL_NAME);
    case 'modal':
      return new ModalModelProvider(config.MODAL_MODEL_URL, config.MODAL_MODEL_TOKEN, config.MODEL_NAME);
    case 'fake':
    default:
      return new FakeModelProvider(() => '{}');
  }
}
