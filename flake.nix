{
  description = "Securely publish generated HTML artifacts behind protected URLs";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      supportedSystems = [ "x86_64-linux" ];
      forAllSystems = lib.genAttrs supportedSystems;
    in
    {
      overlays.default = final: prev: {
        pagebin = final.callPackage ./nix/package.nix { };
      };

      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        rec {
          pagebin = pkgs.callPackage ./nix/package.nix { };
          default = pagebin;
        }
      );

      apps = forAllSystems (
        system:
        let
          pagebinPkg = self.packages.${system}.pagebin;
        in
        rec {
          pagebin = {
            type = "app";
            program = "${pagebinPkg}/bin/pagebin";
            meta.description = "Securely publish generated HTML artifacts behind protected URLs";
          };

          default = pagebin;
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.bun
              pkgs.nodejs_24
              pkgs.prek
              pkgs.wrangler
            ];
          };
        }
      );

      formatter = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        pkgs.nixfmt
      );
    };
}
