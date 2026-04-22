{
  description = "motel: local OpenTelemetry ingest + TUI viewer";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: lib.genAttrs systems (system: f system);

      mkMotel = pkgsArg:
        let
          libArg = pkgsArg.lib;
          fs = pkgsArg.lib.fileset;
          packageJson = libArg.importJSON ./package.json;

          source = fs.toSource {
            root = ./.;
            fileset = fs.difference ./. (fs.unions [
              (fs.maybeMissing ./.git)
              (fs.maybeMissing ./node_modules)
              (fs.maybeMissing ./web/node_modules)
              (fs.maybeMissing ./web/dist)
              (fs.maybeMissing ./.motel-data)
              (fs.maybeMissing ./.otel-data)
              (fs.maybeMissing ./.direnv)
              (fs.maybeMissing ./.envrc)
              (fs.maybeMissing ./result)
            ]);
          };

          nodeModules = pkgsArg.stdenvNoCC.mkDerivation {
            pname = "motel-node-modules";
            version = packageJson.version;

            src = source;

            nativeBuildInputs = [
              pkgsArg.bun
            ];

            dontConfigure = true;

            buildPhase = ''
              runHook preBuild

              export HOME="$TMPDIR/home"
              mkdir -p "$HOME"

              bun install --frozen-lockfile --no-progress

              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p "$out/lib"
              rm -rf node_modules/.cache
              cp -R node_modules "$out/lib/node_modules"

              if [ -d web/node_modules ]; then
                mkdir -p "$out/lib/web"
                cp -R web/node_modules "$out/lib/web/node_modules"
              fi

              runHook postInstall
            '';

            outputHashMode = "recursive";
            outputHashAlgo = "sha256";
            outputHash = "sha256-6cvUQ2Q0FWSbqHYPU0NlAM53gQVLSGdqTQ1pVpK2Ra8=";
          };
        in
        pkgsArg.stdenvNoCC.mkDerivation {
          pname = "motel";
          version = packageJson.version;

          src = source;

          nativeBuildInputs = [
            pkgsArg.bun
            pkgsArg.makeWrapper
          ];

          dontConfigure = true;

          buildPhase = ''
            runHook preBuild

            cp -R ${nodeModules}/lib/node_modules ./node_modules
            chmod -R +w node_modules

            if [ -d ${nodeModules}/lib/web/node_modules ]; then
              mkdir -p web
              cp -R ${nodeModules}/lib/web/node_modules ./web/node_modules
              chmod -R +w web/node_modules
            fi

            export HOME="$TMPDIR/home"
            mkdir -p "$HOME"

            bun run web:build

            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            mkdir -p "$out/bin" "$out/lib/motel/web"

            cp -R src "$out/lib/motel/"
            cp -R node_modules "$out/lib/motel/"
            cp -R web/dist "$out/lib/motel/web/"
            cp package.json bun.lock tsconfig.json LICENSE README.md AGENTS.md "$out/lib/motel/"

            makeWrapper ${pkgsArg.bun}/bin/bun "$out/bin/motel" \
              --add-flags "$out/lib/motel/src/motel.ts"

            makeWrapper ${pkgsArg.bun}/bin/bun "$out/bin/motel-mcp" \
              --add-flags "$out/lib/motel/src/mcp.ts"

            runHook postInstall
          '';

          meta = {
            description = "Local OpenTelemetry ingest + TUI viewer for development";
            homepage = "https://github.com/kitlangton/motel";
            license = libArg.licenses.mit;
            platforms = libArg.platforms.unix;
            mainProgram = "motel";
          };
        };
    in
    {
      overlays.default = final: prev: {
        motel = mkMotel final;
      };

      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          motel = mkMotel pkgs;
        in
        {
          inherit motel;
          default = motel;
        });

      apps = forAllSystems (system:
        let
          pkg = self.packages.${system}.motel;
        in
        {
          motel = {
            type = "app";
            program = "${pkg}/bin/motel";
          };
          default = {
            type = "app";
            program = "${pkg}/bin/motel";
          };
        });

      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.bun
            ];
          };
        });
    };
}
