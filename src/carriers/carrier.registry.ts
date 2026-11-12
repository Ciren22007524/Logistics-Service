import { config } from '../config.js';
import type { CarrierAdapter } from './carrier.interface.js';
import { EcpayCvsAdapter } from './ecpay-cvs/ecpay-cvs.adapter.js';
import { MockAdapter } from './mock/mock.adapter.js';

/** carrier code → adapter。新增物流商：實作 CarrierAdapter 並在這裡註冊。 */
export class CarrierRegistry {
  private readonly adapters = new Map<string, CarrierAdapter>();

  register(adapter: CarrierAdapter): this {
    this.adapters.set(adapter.code, adapter);
    return this;
  }

  get(code: string): CarrierAdapter {
    const a = this.adapters.get(code.toUpperCase());
    if (!a) throw new Error(`unknown carrier ${code}`);
    return a;
  }

  find(code: string): CarrierAdapter | undefined {
    return this.adapters.get(code.toUpperCase());
  }

  list(): CarrierAdapter[] {
    return [...this.adapters.values()];
  }
}

let registry: CarrierRegistry | undefined;

export function carriers(): CarrierRegistry {
  if (!registry) {
    registry = new CarrierRegistry().register(new EcpayCvsAdapter());
    if (config().mockCarrierEnabled) registry.register(new MockAdapter(config().PUBLIC_BASE_URL));
  }
  return registry;
}

export function setCarrierRegistry(r: CarrierRegistry): void {
  registry = r;
}
