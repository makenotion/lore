import config from "./config.json" with { type: "json" }

export function isCheckoutEnabled() {
  return config.flags.newCheckoutFlow === true
}
