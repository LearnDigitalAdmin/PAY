// Products register a handler to react to delivery reports for the sends they tagged (track.product).
import type { ProductHandler } from "./types";
const handlers = new Map<string, ProductHandler>();
export const registerSmsProduct = (product: string, h: ProductHandler): void => { handlers.set(product, h); };
export const getSmsProduct = (product: string): ProductHandler | undefined => handlers.get(product);
