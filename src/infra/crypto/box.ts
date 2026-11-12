import { config } from '../../config.js';
import { SecretBox } from './secrets.js';

let box: SecretBox | undefined;
export function secretBox(): SecretBox {
  box ??= new SecretBox(config().CREDENTIALS_ENC_KEYS);
  return box;
}
