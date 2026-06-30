"""Single source of truth for the app name and sidecar defaults."""

APP_NAME = "Neuclip Studio"

# Fixed-with-fallback port. The sidecar tries this port and increments on conflict,
# then prints the chosen port to stdout for the Rust parent to discover.
DEFAULT_PORT = 8756
PORT_ENV = "NEUCLIP_SIDECAR_PORT"
PORT_STDOUT_PREFIX = f"{PORT_ENV}="  # Rust parses the line starting with this
