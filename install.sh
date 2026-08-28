#!/usr/bin/env bash

set -Eeuo pipefail

readonly REPOSITORY="Fchery87/apex-code"
readonly RELEASES_URL="https://github.com/${REPOSITORY}/releases"
readonly VERSION_PATTERN='^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$'

apex_temp_dir=""

die() {
	echo "apex-code installer: $*" >&2
	exit 1
}

cleanup() {
	if [[ -n "$apex_temp_dir" && -d "$apex_temp_dir" ]]; then
		rm -rf -- "$apex_temp_dir"
	fi
}
trap cleanup EXIT

require_command() {
	command -v "$1" >/dev/null 2>&1 || die "requires '$1' to be installed"
}

resolve_version() {
	local version="${APEX_CODE_INSTALL_VERSION:-}"
	if [[ -z "$version" ]]; then
		require_command curl
		local release_url
		release_url="$(curl --fail --silent --show-error --location --head --output /dev/null --write-out '%{url_effective}' "${RELEASES_URL}/latest")"
		version="${release_url##*/}"
		version="${version#v}"
	fi

	[[ "$version" =~ $VERSION_PATTERN ]] || die "invalid release version '$version'"
	printf '%s\n' "$version"
}

architecture_suffix() {
	case "$(uname -m)" in
		x86_64|amd64) printf '%s\n' "x64" ;;
		aarch64|arm64) printf '%s\n' "arm64" ;;
		*) die "unsupported architecture '$(uname -m)'" ;;
	esac
}

platform_name() {
	local machine="$(uname -s)"
	local architecture
	architecture="$(architecture_suffix)"
	case "$machine" in
		Darwin) printf '%s\n' "darwin-${architecture}" ;;
		Linux) printf '%s\n' "linux-${architecture}" ;;
		MINGW*|MSYS*|CYGWIN*) printf '%s\n' "windows-${architecture}" ;;
		*) die "unsupported operating system '$machine'" ;;
	esac
}

hash_file() {
	local file="$1"
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$file" | awk '{print $1}'
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$file" | awk '{print $1}'
	else
		die "requires sha256sum or shasum to verify the downloaded archive"
	fi
}

zip_listing() {
	local archive="$1"
	if command -v unzip >/dev/null 2>&1; then
		unzip -Z1 "$archive"
		return
	fi
	require_command cygpath
	require_command powershell.exe
	local windows_archive
	windows_archive="$(cygpath -w "$archive")"
	APEX_CODE_ARCHIVE="$windows_archive" powershell.exe -NoLogo -NoProfile -NonInteractive -Command '
		Add-Type -AssemblyName System.IO.Compression.FileSystem
		$zip = [System.IO.Compression.ZipFile]::OpenRead($env:APEX_CODE_ARCHIVE)
		try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }
	'
}

validate_archive_paths() {
	local archive="$1"
	local extension="$2"
	local listing
	if [[ "$extension" == "zip" ]]; then
		listing="$(zip_listing "$archive")"
	else
		require_command tar
		listing="$(tar -tzf "$archive")"
	fi
	awk '
		/^\// || /(^|\/)\.\.($|\/)/ { invalid = 1 }
		END { exit invalid }
	' <<<"$listing" || die "archive contains an unsafe path"
}

extract_archive() {
	local archive="$1"
	local extension="$2"
	local target="$3"
	validate_archive_paths "$archive" "$extension"
	mkdir -p "$target"
	if [[ "$extension" == "zip" ]]; then
		if command -v unzip >/dev/null 2>&1; then
			unzip -q "$archive" -d "$target"
		else
			require_command cygpath
			require_command powershell.exe
			APEX_CODE_ARCHIVE="$(cygpath -w "$archive")" APEX_CODE_TARGET="$(cygpath -w "$target")" \
				powershell.exe -NoLogo -NoProfile -NonInteractive -Command '
					Expand-Archive -LiteralPath $env:APEX_CODE_ARCHIVE -DestinationPath $env:APEX_CODE_TARGET -Force
				'
		fi
	else
		tar -xzf "$archive" -C "$target"
	fi
}

add_unix_path() {
	local bin_dir="$1"
	case ":${PATH}:" in
		*":${bin_dir}:"*) return ;;
	esac
	local profile="${HOME}/.profile"
	local marker="# apex-code installer path"
	if [[ -f "$profile" ]] && grep -Fqx "$marker" "$profile"; then
		return
	fi
	{
		echo
		echo "$marker"
		printf 'export PATH="%s:$PATH"\n' "$bin_dir"
	} >>"$profile"
}

add_windows_user_path() {
	local bin_dir="$1"
	require_command cygpath
	require_command powershell.exe
	local windows_bin_dir
	windows_bin_dir="$(cygpath -w "$bin_dir")"
	APEX_CODE_INSTALL_BIN="$windows_bin_dir" powershell.exe -NoLogo -NoProfile -NonInteractive -Command '
		$bin = $env:APEX_CODE_INSTALL_BIN
		$current = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::User)
		$entries = @($current -split ";" | Where-Object { $_ })
		if (-not [System.Linq.Enumerable]::Contains([string[]]$entries, $bin, [System.StringComparer]::OrdinalIgnoreCase)) {
			[Environment]::SetEnvironmentVariable("Path", (($entries + $bin) -join ";"), [EnvironmentVariableTarget]::User)
		}
	'
}

install_unix() {
	local extracted="$1"
	local version="$2"
	local source_dir="${extracted}/apex-code"
	[[ -x "${source_dir}/apex-code" ]] || die "release archive does not contain an executable apex-code"

	local install_root="${APEX_CODE_INSTALL_DIR:-${HOME}/.local/share/apex-code}"
	local install_dir="${install_root}/${version}"
	local bin_dir="${HOME}/.local/bin"
	mkdir -p "$install_root" "$bin_dir"
	rm -rf -- "$install_dir"
	mv "$source_dir" "$install_dir"
	ln -sfn "${install_dir}/apex-code" "${bin_dir}/apex-code"
	add_unix_path "$bin_dir"
	echo "Installed Apex Code ${version} to ${install_dir}"
	echo "Open a new terminal, then run: apex-code --version"
}

install_windows() {
	local extracted="$1"
	local version="$2"
	[[ -n "${LOCALAPPDATA:-}" ]] || die "LOCALAPPDATA is required on Windows"
	require_command cygpath
	local local_app_data
	local_app_data="$(cygpath -u "$LOCALAPPDATA")"
	local install_dir="${local_app_data}/Apex Code/bin"
	local parent_dir
	parent_dir="$(dirname "$install_dir")"
	local staging_dir="${parent_dir}/.apex-code-install-${RANDOM}-${RANDOM}"
	local backup_dir="${parent_dir}/.apex-code-backup-${RANDOM}-${RANDOM}"
	[[ -f "${extracted}/apex-code.exe" ]] || die "release archive does not contain apex-code.exe"

	mkdir -p "$parent_dir"
	mv "$extracted" "$staging_dir"
	if [[ -e "$install_dir" ]]; then
		mv "$install_dir" "$backup_dir"
	fi
	mv "$staging_dir" "$install_dir"
	rm -rf -- "$backup_dir"
	add_windows_user_path "$install_dir"
	echo "Installed Apex Code ${version} to ${install_dir}"
	echo "Open a new PowerShell, Command Prompt, Windows Terminal, or Git Bash session, then run: apex-code --version"
}

main() {
	require_command curl
	local version
	version="$(resolve_version)"
	local platform
	platform="$(platform_name)"
	local extension="tar.gz"
	if [[ "$platform" == windows-* ]]; then
		extension="zip"
	fi
	local asset="apex-code-${platform}.${extension}"
	local tag="v${version}"
	local asset_url="${RELEASES_URL}/download/${tag}/${asset}"
	local manifest_url="${RELEASES_URL}/download/${tag}/SHA256SUMS"

	apex_temp_dir="$(mktemp -d)" || die "failed to create a temporary directory"
	local manifest="${apex_temp_dir}/SHA256SUMS"
	local archive="${apex_temp_dir}/${asset}"
	curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 3 --output "$manifest" "$manifest_url"
	curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 3 --output "$archive" "$asset_url"

	local expected_hash
	expected_hash="$(awk -v asset="$asset" '$2 == asset { count++; hash = $1 } END { if (count == 1 && length(hash) == 64 && hash ~ /^[0-9a-f]+$/) print hash; else exit 1 }' "$manifest")" || die "checksum manifest does not contain one valid hash for ${asset}"
	local actual_hash
	actual_hash="$(hash_file "$archive")"
	[[ "$actual_hash" == "$expected_hash" ]] || die "checksum mismatch for ${asset}; installation aborted"

	local extracted="${apex_temp_dir}/extracted"
	extract_archive "$archive" "$extension" "$extracted"
	if [[ "$platform" == windows-* ]]; then
		install_windows "$extracted" "$version"
	else
		install_unix "$extracted" "$version"
	fi
}

main "$@"
