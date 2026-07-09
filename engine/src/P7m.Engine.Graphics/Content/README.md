# Compilação dos shaders (MGCB)

Os `.fx` de `../Shaders/` são compilados para `.xnb` pelo MonoGame Content
Builder. A compilação de efeitos requer o toolchain do MGCB (com Wine no
Linux/macOS para o compilador HLSL) e por isso **não roda no CI headless** —
as equações dos shaders são validadas pelas referências de CPU espelhadas
(`Lighting2D`, `ColorLut`, `LinearBlendSkinning`, `BonePacker`), cobertas por
testes.

```bash
dotnet tool install -g dotnet-mgcb   # uma vez
mgcb /@:Content.mgcb                 # compila os efeitos
```

Contratos espelhados (alterou o shader, altere a referência e rode os testes):

| Shader | Referência de CPU |
|---|---|
| `SkinnedMesh.fx` | `P7m.Engine.Core/Rigging/LinearBlendSkinning.cs` + `P7m.Engine.Graphics/BonePacker.cs` |
| `DeferredLight.fx` | `P7m.Engine.Core/Lighting/Lighting2D.cs` |
| `Composite.fx` | `P7m.Engine.Core/Lighting/ColorLut.cs` |
| layout de vértice | `SkinnedVertexDeclaration.cs` ↔ `SkinnedVertex2D.LayoutDescription()` |
