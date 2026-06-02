{
  description = "kobu firmware (RMK + ZMK), hardware & web config app";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # Node 26 hasn't propagated from staging-next into nixos-unstable yet
    # (as of 2026-05-16). Pull `nodejs_26` from staging-next directly while
    # keeping the rest of the toolchain on the stable channel. Re-evaluate
    # when nixos-unstable catches up — at that point this input can be
    # removed and `nodejs` below should switch to `pkgs.nodejs_26`.
    nixpkgs-node.url = "github:NixOS/nixpkgs/staging-next";

    flake-utils.url = "github:numtide/flake-utils";
    fenix = {
      url = "github:nix-community/fenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # ZMK build toolchain (west + Zephyr + gcc-arm-embedded) as a pure Nix
    # derivation — drives the firmware/zmk build (see `packages.zmk*` and the
    # `zmk` devShell below). No west / Zephyr / SDK need be installed on the
    # host. Consumes firmware/zmk/config/west.yml to pin ZMK + modules.
    zmk-nix = {
      url = "github:lilyinstarlight/zmk-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, nixpkgs-node, flake-utils, fenix, zmk-nix }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ fenix.overlays.default ];
        };
        pkgsNode = import nixpkgs-node { inherit system; };

        rustToolchain = pkgs.fenix.combine [
          (pkgs.fenix.stable.withComponents [
            "cargo"
            "clippy"
            "rust-src"
            "rustc"
            "rustfmt"
            "llvm-tools"
          ])
          pkgs.fenix.targets.thumbv7em-none-eabihf.stable.rust-std
        ];

        # Single source of truth for the web app's toolchain. Bump the
        # Node major here and both `nix develop` (local dev) and the
        # `Web` CI workflow follow automatically — they cannot drift.
        # See comment on the `nixpkgs-node` input above for why this
        # currently routes through staging-next.
        nodejs = pkgsNode.nodejs_26;

        kobuUf2Conv = pkgs.writeShellApplication {
          name = "kobu-uf2conv";
          runtimeInputs = [ pkgs.python3 ];
          text = ''
            exec python3 - "$@" <<'PY'
            import math
            import struct
            import sys
            from pathlib import Path

            MAGIC_START0 = 0x0A324655
            MAGIC_START1 = 0x9E5D5157
            MAGIC_END = 0x0AB16F30
            FLAG_FAMILY_ID = 0x00002000
            NRF52840_FAMILY = 0xADA52840
            DEFAULT_BASE = 0x1000
            PAYLOAD = 256

            def usage(code=2):
                print("usage: kobu-uf2conv <input.elf|input.bin> [output.uf2] [base-address-for-bin]", file=sys.stderr)
                print("       base-address defaults to 0x1000 for raw .bin input", file=sys.stderr)
                raise SystemExit(code)

            def parse_int(value):
                return int(value, 0)

            def load_elf_segments(data):
                if data[:4] != b"\x7fELF":
                    return None
                if data[4] != 1 or data[5] != 1:
                    raise SystemExit("kobu-uf2conv: only little-endian ELF32 is supported")

                e_phoff = struct.unpack_from("<I", data, 28)[0]
                e_phentsize = struct.unpack_from("<H", data, 42)[0]
                e_phnum = struct.unpack_from("<H", data, 44)[0]
                segments = []
                for index in range(e_phnum):
                    off = e_phoff + index * e_phentsize
                    p_type, p_offset, _p_vaddr, p_paddr, p_filesz, _p_memsz, _p_flags, _p_align = struct.unpack_from("<IIIIIIII", data, off)
                    if p_type != 1 or p_filesz == 0:
                        continue
                    segments.append((p_paddr, data[p_offset:p_offset + p_filesz]))
                if not segments:
                    raise SystemExit("kobu-uf2conv: ELF has no loadable segments")
                return segments

            def bin_segment(data, base):
                return [(base, data)]

            def linearize_segments(segments):
                start = min(base for base, _segment in segments)
                if start % PAYLOAD:
                    start -= start % PAYLOAD
                end = max(base + len(segment) for base, segment in segments)
                image = bytearray([0xFF]) * (end - start)
                for base, segment in sorted(segments):
                    begin = base - start
                    finish = begin + len(segment)
                    image[begin:finish] = segment
                return start, bytes(image)

            def write_uf2(segments, output):
                start, image = linearize_segments(segments)
                blocks = []
                for offset in range(0, len(image), PAYLOAD):
                    chunk = image[offset:offset + PAYLOAD]
                    chunk = chunk + bytes(PAYLOAD - len(chunk))
                    blocks.append((start + offset, chunk))

                out = bytearray()
                total = len(blocks)
                for block_no, (addr, chunk) in enumerate(blocks):
                    header = struct.pack(
                        "<IIIIIIII",
                        MAGIC_START0,
                        MAGIC_START1,
                        FLAG_FAMILY_ID,
                        addr,
                        PAYLOAD,
                        block_no,
                        total,
                        NRF52840_FAMILY,
                    )
                    out += header + chunk + bytes(512 - 32 - PAYLOAD - 4) + struct.pack("<I", MAGIC_END)
                output.write_bytes(out)

            if len(sys.argv) == 2 and sys.argv[1] in ("-h", "--help"):
                usage(0)
            if not (2 <= len(sys.argv) <= 4):
                usage()

            input_path = Path(sys.argv[1])
            output_path = Path(sys.argv[2]) if len(sys.argv) >= 3 else input_path.with_suffix(".uf2")
            data = input_path.read_bytes()
            segments = load_elf_segments(data)
            if segments is None:
                base = parse_int(sys.argv[3]) if len(sys.argv) == 4 else DEFAULT_BASE
                segments = bin_segment(data, base)
            elif len(sys.argv) == 4:
                raise SystemExit("kobu-uf2conv: base-address is only valid for raw .bin input")

            write_uf2(segments, output_path)
            print(output_path)
            PY
          '';
        };

        firmwarePackages = [
          rustToolchain
          pkgs.flip-link
          kobuUf2Conv
          pkgs.probe-rs-tools
          pkgs.cargo-binutils
          pkgs.cargo-generate
          pkgs.pkg-config
          pkgs.libusb1
          # Required by bindgen (used by nrf-mpsl-sys through rmk).
          pkgs.llvmPackages.libclang
          pkgs.clang
          # Render keymap SVG from firmware/rmk/keymap/*.yaml.
          pkgs.python3Packages.keymap-drawer
        ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
          pkgs.systemd
        ];

        webPackages = [
          nodejs
          pkgs.pnpm
        ];

        firmwareEnv = {
          # Tell bindgen which libclang to load. Without this it falls
          # back to the host system libclang which on GitHub runners
          # lacks a compatible libstdc++.
          LIBCLANG_PATH = "${pkgs.llvmPackages.libclang.lib}/lib";
        };

        # ── ZMK firmware (firmware/zmk) ──────────────────────────────────
        # The ZMK config lives in the firmware/zmk/ subtree; root the build
        # there so zmk-nix sees config/ + zephyr/module.yml at the src root.
        zmkLib = zmk-nix.legacyPackages.${system};
        zmkSrc = pkgs.lib.sourceFilesBySuffices ./firmware/zmk [
          ".board" ".cmake" ".conf" ".defconfig" ".dts" ".dtsi"
          ".json" ".keymap" ".overlay" ".shield" ".yml" "_defconfig"
        ];
        zmkBoard = "seeeduino_xiao_ble";
        # FIXED-OUTPUT hash of the west-fetched module tree (ZMK v0.3 + Zephyr
        # + pmw3610 driver + rgbled-widget v0.3, per firmware/zmk/config/west.yml).
        # Re-bootstrap if that west.yml changes: set lib.fakeHash, build, paste
        # the reported `got: sha256-...`.
        zmkDepsHash = "sha256-jeXqoHbIo2Qci2whC/G3ITNCDzCNJul85DhmsfSncA0=";
        zmkMeta = {
          license = pkgs.lib.licenses.mit;
          platforms = pkgs.lib.platforms.all;
        };

        # Both halves -> $out/zmk_left.uf2 + zmk_right.uf2. enableZmkStudio is
        # auto-applied to the central (left) part only.
        zmkFirmware = zmkLib.buildSplitKeyboard {
          name = "kobu-zmk-firmware";
          src = zmkSrc;
          board = zmkBoard;
          shield = "kobu_%PART% rgbled_adapter";
          parts = [ "left" "right" ];
          centralPart = "left";
          enableZmkStudio = true;
          zephyrDepsHash = zmkDepsHash;
          meta = zmkMeta // { description = "kobu split keyboard ZMK firmware (both halves)"; };
        };

        # settings_reset image; reuses the same westDeps (no second fetch/hash).
        zmkReset = zmkLib.buildKeyboard {
          name = "kobu-zmk-settings-reset";
          src = zmkSrc;
          board = zmkBoard;
          shield = "settings_reset";
          zephyrDepsHash = zmkDepsHash;
          inherit (zmkFirmware) westDeps;
          meta = zmkMeta // { description = "kobu settings_reset UF2"; };
        };

        # kobu-named UF2 bundle. `nix build .#zmk-bundle` -> result/ has
        # kobu_left.uf2 / kobu_right.uf2 / kobu_reset.uf2.
        zmkBundle = pkgs.runCommand "kobu-zmk-uf2-bundle" { } ''
          mkdir -p $out
          cp -L ${zmkFirmware}/zmk_left.uf2  $out/kobu_left.uf2
          cp -L ${zmkFirmware}/zmk_right.uf2 $out/kobu_right.uf2
          cp -L ${zmkReset}/zmk.uf2          $out/kobu_reset.uf2
        '';
      in
      {
        packages = {
          # ZMK firmware (both halves).        nix build .#zmk
          zmk = zmkFirmware;
          # kobu-named UF2 bundle + reset.     nix build .#zmk-bundle
          zmk-bundle = zmkBundle;
          # settings_reset UF2 only.           nix build .#zmk-reset
          zmk-reset = zmkReset;
        };

        devShells = {
          # Full kit — both firmware and web. The default shell for
          # local dev when you might switch between firmware/ and web/
          # in the same session.
          default = pkgs.mkShell {
            packages = firmwarePackages ++ webPackages;
            env = firmwareEnv;
            shellHook = ''
              echo "kobu devshell ready (firmware + web)"
              echo "  rustc: $(rustc --version)"
              echo "  node:  $(node --version)"
              echo "  pnpm:  $(pnpm --version)"
              if ! command -v rmkit >/dev/null 2>&1; then
                echo "  note: 'rmkit' is not installed in this shell."
                echo "  install with: cargo install --locked rmkit"
              fi
              if ! command -v uf2conv >/dev/null 2>&1; then
                echo "  note: 'uf2conv' is not installed in this shell."
                echo "  install with: cargo install --locked uf2conv"
              fi
            '';
          };

          # RMK firmware-only (firmware/rmk). Used by `firmware/rmk/.envrc`
          # and `.github/workflows/firmware.yml` so the CI runner does not
          # also have to materialise Node / pnpm just to build the binary.
          firmware = pkgs.mkShell {
            packages = firmwarePackages;
            env = firmwareEnv;
            shellHook = ''
              echo "kobu firmware (RMK) devshell"
              echo "  rustc: $(rustc --version)"
            '';
          };

          # Web-only. Used by `.github/workflows/web.yml` so the
          # cold-cache time on the runner is just Node + pnpm and not
          # the entire Rust toolchain + probe-rs + clang.
          web = pkgs.mkShell {
            packages = webPackages;
            shellHook = ''
              echo "kobu web devshell"
              echo "  node:  $(node --version)"
              echo "  pnpm:  $(pnpm --version)"
            '';
          };

          # ZMK build shell (west + cmake + ninja + dtc + gcc-arm-embedded +
          # python). Used by `firmware/zmk/.envrc` for manual `west` builds /
          # inspection; the packaged build is `nix build .#zmk-bundle`.
          #
          # A lean, hand-rolled shell rather than zmk-nix's own devShell: the
          # latter pulls Zephyr's full python requirements (incl. canopen),
          # whose flaky timing tests fail to build on some nixpkgs. ZMK only
          # needs west + a handful of helpers to `west build`, so this avoids
          # canopen entirely.
          zmk = pkgs.mkShell {
            packages = [
              pkgs.cmake
              pkgs.ninja
              pkgs.dtc
              pkgs.gcc-arm-embedded
              pkgs.git
              (pkgs.python3.withPackages (ps: [
                ps.west
                ps.pyelftools
                ps.pyyaml
                ps.pykwalify
              ]))
            ];
            env = {
              ZEPHYR_TOOLCHAIN_VARIANT = "gnuarmemb";
              GNUARMEMB_TOOLCHAIN_PATH = "${pkgs.gcc-arm-embedded}";
            };
            shellHook = ''
              echo "kobu ZMK build shell (west + gcc-arm-embedded)"
              echo "  packaged build (from repo root): nix build .#zmk-bundle"
            '';
          };
        };
      });
}
