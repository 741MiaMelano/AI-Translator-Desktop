#!/usr/bin/env bash

set -euo pipefail

SOURCE_COMMIT="998de74adf861c26df557e220996faa959419549"
SOURCE_ARCHIVE_SHA256="8add93552e8e3cc45a991296cfabfe5d002565997d201a7ee79903a979311ea8"
SOURCE_URL="https://github.com/FFmpeg/FFmpeg/archive/${SOURCE_COMMIT}.zip"
SOURCE_DIR_NAME="FFmpeg-${SOURCE_COMMIT}"
SOURCE_DATE_EPOCH="1784764800"
ARTIFACT_BASENAME="ffmpeg-n7.1.5-2-g998de74adf-win64-lgpl-shared-libass"

FREETYPE_VERSION="2.13.3"
FREETYPE_URL="https://download.savannah.gnu.org/releases/freetype/freetype-${FREETYPE_VERSION}.tar.xz"
FREETYPE_SHA256="0550350666d427c74daeb85d5ac7bb353acba5f76956395995311a9c6f063289"
FRIBIDI_VERSION="1.0.16"
FRIBIDI_URL="https://github.com/fribidi/fribidi/archive/refs/tags/v${FRIBIDI_VERSION}.tar.gz"
FRIBIDI_SHA256="5a1d187a33daa58fcee2ad77f0eb9d136dd6fa4096239199ba31e850d397e8a8"
HARFBUZZ_VERSION="10.2.0"
HARFBUZZ_URL="https://github.com/harfbuzz/harfbuzz/archive/refs/tags/${HARFBUZZ_VERSION}.tar.gz"
HARFBUZZ_SHA256="11749926914fd488e08e744538f19329332487a6243eec39ef3c63efa154a578"
LIBASS_VERSION="0.17.5"
LIBASS_URL="https://github.com/libass/libass/archive/refs/tags/${LIBASS_VERSION}.tar.gz"
LIBASS_SHA256="fa286fc9ee1ba3b932703a3df7b8474d01dc8abe29ec69b6fa68781dc4bf7acc"
MESON_VERSION="1.7.2"
MESON_URL="https://github.com/mesonbuild/meson/archive/refs/tags/${MESON_VERSION}.tar.gz"
MESON_SHA256="3640ef596523393100df31ba790bc5fe732215e9711a66b673a21c4eb39bc8f1"
NINJA_VERSION="1.12.1"
NINJA_URL="https://github.com/ninja-build/ninja/archive/refs/tags/v${NINJA_VERSION}.tar.gz"
NINJA_SHA256="821bdff48a3f683bc4bb3b6f0b5fe7b2d647cf65d52aeb63328c91a6c6df285a"
MINGW_GXX_VERSION="13.2.0-6ubuntu1+26.1"
MINGW_GXX_URL="https://archive.ubuntu.com/ubuntu/pool/universe/g/gcc-mingw-w64/g%2b%2b-mingw-w64-x86-64-win32_13.2.0-6ubuntu1%2b26.1_amd64.deb"
MINGW_GXX_SHA256="82ff9a2137f31c16c8cc8dd63b39c1a14416e1246033c7246b8070b7383d189a"

CONFIGURE_FLAGS=(
  "--prefix=/ffmpeg-libass"
  "--target-os=mingw32"
  "--arch=x86_64"
  "--cross-prefix=x86_64-w64-mingw32-"
  "--pkg-config=pkg-config"
  "--enable-shared"
  "--disable-static"
  "--disable-autodetect"
  "--disable-debug"
  "--disable-doc"
  "--disable-ffplay"
  "--disable-network"
  "--disable-iconv"
  "--disable-zlib"
  "--disable-bzlib"
  "--disable-lzma"
  "--enable-libass"
)

usage() {
  cat <<'EOF'
Usage:
  scripts/build-ffmpeg-wsl.sh --print-config
  scripts/build-ffmpeg-wsl.sh --work-dir DIR --output-dir DIR [--source-archive FILE] [--jobs N]

The build directory and output directory must not already exist. The optional
source archive must match the SHA-256 pinned in this script.
EOF
}

print_config() {
  local configure_line
  printf -v configure_line '%q ' "${CONFIGURE_FLAGS[@]}"
  printf 'source_commit=%s\n' "$SOURCE_COMMIT"
  printf 'source_url=%s\n' "$SOURCE_URL"
  printf 'source_archive_sha256=%s\n' "$SOURCE_ARCHIVE_SHA256"
  printf 'source_date_epoch=%s\n' "$SOURCE_DATE_EPOCH"
  printf 'artifact_basename=%s\n' "$ARTIFACT_BASENAME"
  printf 'freetype=%s %s\n' "$FREETYPE_VERSION" "$FREETYPE_SHA256"
  printf 'fribidi=%s %s\n' "$FRIBIDI_VERSION" "$FRIBIDI_SHA256"
  printf 'harfbuzz=%s %s\n' "$HARFBUZZ_VERSION" "$HARFBUZZ_SHA256"
  printf 'libass=%s %s\n' "$LIBASS_VERSION" "$LIBASS_SHA256"
  printf 'meson=%s %s\n' "$MESON_VERSION" "$MESON_SHA256"
  printf 'ninja=%s %s\n' "$NINJA_VERSION" "$NINJA_SHA256"
  printf 'mingw_gxx=%s %s\n' "$MINGW_GXX_VERSION" "$MINGW_GXX_SHA256"
  printf 'configure=%s\n' "${configure_line% }"
}

fail() {
  printf 'build-ffmpeg-wsl: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

work_dir=""
output_dir=""
source_archive=""
jobs="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '1')"

parse_arguments() {
  while (($# > 0)); do
    case "$1" in
      --print-config)
        print_config
        exit 0
        ;;
      --work-dir|--output-dir|--source-archive|--jobs)
        (($# >= 2)) || fail "missing value for $1"
        case "$1" in
          --work-dir) work_dir="$2" ;;
          --output-dir) output_dir="$2" ;;
          --source-archive) source_archive="$2" ;;
          --jobs) jobs="$2" ;;
        esac
        shift 2
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        fail "unknown argument: $1"
        ;;
    esac
  done
}

validate_inputs() {
  [[ -n "$work_dir" ]] || fail "--work-dir is required"
  [[ -n "$output_dir" ]] || fail "--output-dir is required"
  [[ "$jobs" =~ ^[1-9][0-9]*$ ]] || fail "--jobs must be a positive integer"
  [[ ! -e "$work_dir" ]] || fail "work directory already exists: $work_dir"
  [[ ! -e "$output_dir" ]] || fail "output directory already exists: $output_dir"
  if [[ -n "$source_archive" ]]; then
    [[ -f "$source_archive" ]] || fail "source archive not found: $source_archive"
  fi
}

check_toolchain() {
  local command_name
  for command_name in sha256sum unzip tar make nasm zip python3 gcc g++ pkg-config dpkg-deb \
    x86_64-w64-mingw32-gcc \
    x86_64-w64-mingw32-ar x86_64-w64-mingw32-strip \
    x86_64-w64-mingw32-windres x86_64-w64-mingw32-objdump; do
    require_command "$command_name"
  done
  [[ -n "$source_archive" ]] || require_command curl
}

prepare_workspace() {
  mkdir -p "$work_dir" "$output_dir"
  work_dir="$(cd "$work_dir" && pwd -P)"
  output_dir="$(cd "$output_dir" && pwd -P)"
  downloaded_archive="$work_dir/${SOURCE_DIR_NAME}.zip"
  source_root="$work_dir/source"
  source_dir="$source_root/$SOURCE_DIR_NAME"
  freetype_source="$source_root/freetype-${FREETYPE_VERSION}"
  fribidi_source="$source_root/fribidi-${FRIBIDI_VERSION}"
  harfbuzz_source="$source_root/harfbuzz-${HARFBUZZ_VERSION}"
  libass_source="$source_root/libass-${LIBASS_VERSION}"
  meson_source="$source_root/meson-${MESON_VERSION}"
  ninja_source="$source_root/ninja-${NINJA_VERSION}"
  tools_bin="$work_dir/tools/bin"
  gxx_root="$work_dir/tools/mingw-gxx"
  deps_prefix="$work_dir/deps"
  cross_file="$work_dir/mingw-cross.ini"
  build_log="$work_dir/build.log"
  staged="$output_dir/staged"
  archive="$output_dir/${ARTIFACT_BASENAME}.zip"
  script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")"
  script_sha256="$(sha256sum "$script_path" | awk '{print $1}')"
}

acquire_source() {
  if [[ -n "$source_archive" ]]; then
    cp "$source_archive" "$downloaded_archive"
  else
    curl --fail --location --retry 3 --output "$downloaded_archive" "$SOURCE_URL"
  fi
  printf '%s  %s\n' "$SOURCE_ARCHIVE_SHA256" "$downloaded_archive" | sha256sum --check --status \
    || fail "source archive SHA-256 does not match the pinned value"

  mkdir "$source_root"
  unzip -q "$downloaded_archive" -d "$source_root"
  [[ -x "$source_dir/configure" ]] || fail "source archive layout is not the pinned FFmpeg tree"

  acquire_component "$FREETYPE_URL" "$FREETYPE_SHA256" "$work_dir/freetype.tar.xz"
  acquire_component "$FRIBIDI_URL" "$FRIBIDI_SHA256" "$work_dir/fribidi.tar.gz"
  acquire_component "$HARFBUZZ_URL" "$HARFBUZZ_SHA256" "$work_dir/harfbuzz.tar.gz"
  acquire_component "$LIBASS_URL" "$LIBASS_SHA256" "$work_dir/libass.tar.gz"
  acquire_component "$MESON_URL" "$MESON_SHA256" "$work_dir/meson.tar.gz"
  acquire_component "$NINJA_URL" "$NINJA_SHA256" "$work_dir/ninja.tar.gz"
  acquire_component "$MINGW_GXX_URL" "$MINGW_GXX_SHA256" "$work_dir/mingw-gxx.deb"
  tar xf "$work_dir/freetype.tar.xz" -C "$source_root"
  tar xf "$work_dir/fribidi.tar.gz" -C "$source_root"
  tar xf "$work_dir/harfbuzz.tar.gz" -C "$source_root"
  tar xf "$work_dir/libass.tar.gz" -C "$source_root"
  tar xf "$work_dir/meson.tar.gz" -C "$source_root"
  tar xf "$work_dir/ninja.tar.gz" -C "$source_root"
}

acquire_component() {
  local url="$1"
  local sha256="$2"
  local target="$3"
  curl --fail --location --retry 3 --output "$target" "$url"
  printf '%s  %s\n' "$sha256" "$target" | sha256sum --check --status \
    || fail "component source SHA-256 does not match: $url"
}

build_tools() {
  mkdir -p "$tools_bin"
  local system_gcc_dir
  system_gcc_dir="$(dirname "$(x86_64-w64-mingw32-gcc -print-libgcc-file-name)")"
  [[ -f "$system_gcc_dir/liblto_plugin.so" ]] || fail "system MinGW GCC support directory is incomplete"
  mkdir -p "$gxx_root/usr/lib/gcc/x86_64-w64-mingw32/13-win32"
  cp -a "$system_gcc_dir/." "$gxx_root/usr/lib/gcc/x86_64-w64-mingw32/13-win32/"
  dpkg-deb -x "$work_dir/mingw-gxx.deb" "$gxx_root"
  ln -s /usr/x86_64-w64-mingw32 "$gxx_root/usr/x86_64-w64-mingw32"
  ln -s x86_64-w64-mingw32-g++-win32 "$gxx_root/usr/bin/x86_64-w64-mingw32-g++"
  (
    cd "$ninja_source"
    python3 configure.py --bootstrap
  )
  install -m 0755 "$ninja_source/ninja" "$tools_bin/ninja"
  export PATH="$gxx_root/usr/bin:$tools_bin:$PATH"
  require_command x86_64-w64-mingw32-g++
  meson=(python3 "$meson_source/meson.py")
}

write_cross_file() {
  cat >"$cross_file" <<'EOF'
[binaries]
c = 'x86_64-w64-mingw32-gcc'
cpp = 'x86_64-w64-mingw32-g++'
ar = 'x86_64-w64-mingw32-ar'
strip = 'x86_64-w64-mingw32-strip'
windres = 'x86_64-w64-mingw32-windres'
pkg-config = 'pkg-config'

[host_machine]
system = 'windows'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'

[properties]
needs_exe_wrapper = true

[built-in options]
c_args = ['-O2']
c_link_args = ['-static-libgcc']
cpp_args = ['-O2']
cpp_link_args = ['-static-libgcc', '-static-libstdc++']
EOF
}

meson_install() {
  local source="$1"
  local name="$2"
  shift 2
  local build="$work_dir/build-$name"
  PKG_CONFIG_LIBDIR="$deps_prefix/lib/pkgconfig" \
    "${meson[@]}" setup "$build" "$source" \
      --cross-file "$cross_file" --prefix "$deps_prefix" --libdir lib \
      --buildtype release --default-library shared --wrap-mode nodownload "$@"
  "${meson[@]}" compile -C "$build" -j "$jobs"
  "${meson[@]}" install -C "$build"
}

build_dependencies() {
  mkdir -p "$deps_prefix"
  meson_install "$freetype_source" freetype \
    -Dzlib=disabled -Dbzip2=disabled -Dpng=disabled -Dbrotli=disabled \
    -Dharfbuzz=disabled -Dtests=disabled
  meson_install "$fribidi_source" fribidi -Ddocs=false -Dbin=false -Dtests=false
  meson_install "$harfbuzz_source" harfbuzz \
    -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dchafa=disabled \
    -Dicu=disabled -Dgraphite2=disabled -Dfreetype=disabled \
    -Dtests=disabled -Dintrospection=disabled -Ddocs=disabled \
    -Dutilities=disabled -Dbenchmark=disabled
  meson_install "$libass_source" libass \
    -Dfontconfig=disabled -Ddirectwrite=enabled -Dcoretext=disabled \
    -Dlibunibreak=disabled -Dtest=disabled -Dcompare=disabled \
    -Dprofile=disabled -Dfuzz=disabled -Dcheckasm=disabled
}

build_ffmpeg() {
  (
    cd "$source_dir"
    PKG_CONFIG_LIBDIR="$deps_prefix/lib/pkgconfig" ./configure "${CONFIGURE_FLAGS[@]}"
    make -j"$jobs"
  ) 2>&1 | tee "$build_log"
}

stage_runtime() {
  local dll
  local -a dlls
  mkdir -p "$staged/bin" "$staged/licenses"
  install -m 0755 "$source_dir/ffmpeg.exe" "$staged/bin/ffmpeg.exe"
  install -m 0755 "$source_dir/ffprobe.exe" "$staged/bin/ffprobe.exe"

  mapfile -d '' dlls < <(find "$source_dir" -mindepth 2 -maxdepth 2 -type f -name '*.dll' -print0 | sort -z)
  ((${#dlls[@]} > 0)) || fail "shared build produced no FFmpeg DLLs"
  for dll in "${dlls[@]}"; do
    install -m 0755 "$dll" "$staged/bin/$(basename "$dll")"
  done
  find "$deps_prefix/bin" -maxdepth 1 -type f -name '*.dll' -exec install -m 0755 {} "$staged/bin" \;

  install -m 0644 "$source_dir/COPYING.LGPLv2.1" "$staged/licenses/COPYING.LGPLv2.1.txt"
  install -m 0644 "$source_dir/LICENSE.md" "$staged/licenses/FFmpeg-LICENSE.md"
  install -m 0644 "$freetype_source/docs/FTL.TXT" "$staged/licenses/FREETYPE-FTL.txt"
  install -m 0644 "$fribidi_source/COPYING" "$staged/licenses/FRIBIDI-LGPLv2.1.txt"
  install -m 0644 "$harfbuzz_source/COPYING" "$staged/licenses/HARFBUZZ-COPYING.txt"
  install -m 0644 "$libass_source/COPYING" "$staged/licenses/LIBASS-ISC.txt"
}

write_disclosures() {
  local configure_line
  printf -v configure_line '%q ' "${CONFIGURE_FLAGS[@]}"
  configure_line="${configure_line% }"

  cat >"$staged/licenses/THIRD-PARTY-NOTICES.txt" <<EOF
FFmpeg redistribution notice

This package contains FFmpeg built from source commit ${SOURCE_COMMIT}.
FFmpeg is licensed primarily under LGPL-2.1-or-later. This build does not use
--enable-gpl or --enable-nonfree. It is dynamically linked to the accompanying
FFmpeg DLLs and to libass ${LIBASS_VERSION}. libass uses dynamically linked
FreeType ${FREETYPE_VERSION}, FriBidi ${FRIBIDI_VERSION}, and HarfBuzz
${HARFBUZZ_VERSION}. Windows font discovery uses DirectWrite/GDI; Fontconfig is
not included.

License texts are staged beside this notice: FFmpeg LGPL/FFmpeg-LICENSE,
libass ISC, FreeType FTL, FriBidi LGPL-2.1-or-later, and HarfBuzz's COPYING
rollup. This notice is not legal advice.
EOF

  cat >"$staged/licenses/SOURCE-AND-BUILD.txt" <<EOF
FFmpeg corresponding source and build disclosure

Source commit: ${SOURCE_COMMIT}
Source archive: ${SOURCE_URL}
Source archive SHA-256: ${SOURCE_ARCHIVE_SHA256}
libass: ${LIBASS_URL}
libass SHA-256: ${LIBASS_SHA256}
FreeType: ${FREETYPE_URL}
FreeType SHA-256: ${FREETYPE_SHA256}
FriBidi: ${FRIBIDI_URL}
FriBidi SHA-256: ${FRIBIDI_SHA256}
HarfBuzz: ${HARFBUZZ_URL}
HarfBuzz SHA-256: ${HARFBUZZ_SHA256}
Meson build tool: ${MESON_URL}
Meson SHA-256: ${MESON_SHA256}
Ninja build tool: ${NINJA_URL}
Ninja SHA-256: ${NINJA_SHA256}
MinGW C++ build tool package: ${MINGW_GXX_URL}
MinGW C++ package SHA-256: ${MINGW_GXX_SHA256}
Build recipe: scripts/build-ffmpeg-wsl.sh
Build recipe SHA-256: ${script_sha256}
Configure: ${configure_line}

The source archives and recipe above are sufficient to rebuild this package in
the pinned environment recorded by the release manifest.
EOF
}

write_environment_report() {
  {
    printf 'uname: '
    uname -a
    x86_64-w64-mingw32-gcc --version | head -n 1
    x86_64-w64-mingw32-g++ --version | head -n 1
    nasm -v
    make --version | head -n 1
    "${meson[@]}" --version
    ninja --version
    printf 'build_recipe_sha256=%s\n' "$script_sha256"
    print_config
  } >"$output_dir/build-environment.txt"
}

verify_architecture() {
  local executable
  for executable in "$staged/bin/ffmpeg.exe" "$staged/bin/ffprobe.exe"; do
    x86_64-w64-mingw32-objdump -f "$executable" | grep -q 'architecture: i386:x86-64' \
      || fail "unexpected executable architecture: $executable"
  done
}

package_staged_tree() {
  local -a files
  find "$staged" -type f -exec touch --date="@${SOURCE_DATE_EPOCH}" {} +
  (
    cd "$staged"
    mapfile -d '' files < <(find . -type f -print0 | sort -z)
    zip -X -q "$archive" "${files[@]}"
  )
  sha256sum "$archive" >"$output_dir/${ARTIFACT_BASENAME}.zip.sha256"
  cp "$build_log" "$output_dir/build.log"
}

main() {
  parse_arguments "$@"
  validate_inputs
  check_toolchain
  prepare_workspace
  acquire_source

  export LC_ALL=C
  export TZ=UTC
  export SOURCE_DATE_EPOCH

  build_tools
  write_cross_file
  build_dependencies
  build_ffmpeg
  stage_runtime
  write_disclosures
  write_environment_report
  verify_architecture
  package_staged_tree
  printf 'Build complete: %s\n' "$archive"
}

main "$@"
