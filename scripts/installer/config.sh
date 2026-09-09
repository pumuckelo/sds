# Sourced by scripts/install.sh; bundled for release distribution.

repository="pumuckelo/sds"
package_name="sds"
binaries="sds sds-dashboard"

fail() {
  echo "Error: $*" >&2
  exit 1
}
