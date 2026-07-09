using P7m.Engine.Core.Lighting;
using P7m.Engine.Core.Rigging;
using P7m.Engine.Core.SharedMemory;
using P7m.Engine.Ipc;
using P7m.Engine.Ipc.Protocol;

namespace P7m.Engine.Runtime;

/// <summary>
/// Constrói o manifesto de capacidades servido por <c>engine/describe</c>.
///
/// É por aqui que a engine "se apresenta" ao ecossistema: cada subsistema
/// declara seus limites reais (extraídos das constantes do núcleo DOD), seus
/// layouts binários (derivados por reflexão das structs — nunca hardcoded) e
/// os ganchos de edição visual (<c>editor</c>) que o middleware repassa ao
/// editor Electron para materializar painéis, gizmos e tipos de nó.
/// </summary>
public static class EngineDescriptor
{
    public static object BuildManifest(SkeletonStore skeletons, LightStore lights) => new
    {
        engine = new
        {
            name = EngineChannel.ClientName,
            version = EngineChannel.ClientVersion,
            protocolVersion = JsonRpcProtocol.ProtocolVersion,
        },
        subsystems = new
        {
            rigging = new
            {
                status = "available",
                limits = new Dictionary<string, double>
                {
                    ["maxSkeletons"] = skeletons.Capacity,
                    ["maxBonesPerSkeleton"] = SkeletonStore.MaxBonesPerSkeleton,
                    ["maxBoneInfluencesPerVertex"] = 4,
                },
                features = new[] { "linear-blend-skinning", "topological-reorder", "bind-pose-resolution" },
                editor = new
                {
                    panel = "rig-editor",
                    gizmos = new[] { "bone", "ik-chain", "weight-brush" },
                    nodeTypes = new[] { "skeleton", "bone", "ik-target" },
                    properties = new object[]
                    {
                        new { name = "boneLength", type = "float", min = 0.0, max = 4096.0, @default = 32.0 },
                        new { name = "ikSolver", type = "enum", options = new[] { "fabrik" }, @default = "fabrik" },
                        new { name = "easing", type = "curve", @default = "cubic-bezier" },
                    },
                },
            },
            sharedMemory = new
            {
                status = "available",
                limits = new Dictionary<string, double>
                {
                    ["headerBytes"] = MeshBufferHeader.HeaderBytes,
                    ["layoutVersion"] = SkinnedVertex2D.LayoutVersion,
                },
                features = new[] { "seqlock", "fnv1a-checksum", "file-backed-mmf" },
                vertexLayouts = new object[]
                {
                    new
                    {
                        name = nameof(SkinnedVertex2D),
                        layoutVersion = SkinnedVertex2D.LayoutVersion,
                        strideInBytes = SkinnedVertex2D.StrideInBytes,
                        fields = SkinnedVertex2D.LayoutDescription()
                            .Select(f => new { name = f.Name, offset = f.Offset, type = f.Type, semantic = f.Semantic })
                            .ToArray(),
                    },
                },
                editor = new
                {
                    panel = "mesh-inspector",
                    gizmos = new[] { "vertex-handles", "uv-overlay" },
                    nodeTypes = new[] { "mesh", "shared-buffer" },
                    properties = Array.Empty<object>(),
                },
            },
            camera = new
            {
                status = "available",
                features = new[]
                {
                    "second-order-spring-damper", "predictive-lookahead",
                    "procedural-harmonic-shake", "deterministic-simulation",
                },
                editor = new
                {
                    panel = "camera-rig",
                    gizmos = new[] { "follow-target", "anticipation-vector", "shake-preview" },
                    nodeTypes = new[] { "camera", "shake-layer" },
                    properties = new object[]
                    {
                        new { name = "frequency", type = "float", min = 0.1, max = 10.0, @default = 2.0 },
                        new { name = "damping", type = "float", min = 0.0, max = 2.0, @default = 1.0 },
                        new { name = "response", type = "float", min = -2.0, max = 2.0, @default = 0.0 },
                        new { name = "anticipationSeconds", type = "float", min = 0.0, max = 1.0, @default = 0.25 },
                        new { name = "shakeMaxOffset", type = "float", min = 0.0, max = 128.0, @default = 24.0 },
                        new { name = "shakeFrequencyHz", type = "float", min = 1.0, max = 60.0, @default = 18.0 },
                    },
                },
            },
            lighting = new
            {
                status = "available",
                limits = new Dictionary<string, double>
                {
                    ["maxLights"] = lights.Capacity,
                },
                features = new[] { "deferred-2d", "mrt-gbuffer", "normal-maps", "color-lut", "cpu-reference-eval" },
                vertexLayouts = Array.Empty<object>(),
                editor = new
                {
                    panel = "lighting-pipeline",
                    gizmos = new[] { "light-radius", "spot-cone", "direction-arrow" },
                    nodeTypes = new[] { "point-light", "directional-light", "spot-light", "lut-grade" },
                    properties = new object[]
                    {
                        new { name = "intensity", type = "float", min = 0.0, max = 16.0, @default = 1.0 },
                        new { name = "color", type = "color", @default = "#ffffff" },
                        new { name = "radius", type = "float", min = 1.0, max = 4096.0, @default = 256.0 },
                        new { name = "innerConeDegrees", type = "float", min = 1.0, max = 179.0, @default = 30.0 },
                        new { name = "outerConeDegrees", type = "float", min = 1.0, max = 179.0, @default = 60.0 },
                        new { name = "lutStrength", type = "float", min = 0.0, max = 1.0, @default = 0.0 },
                    },
                },
            },
            assets = new
            {
                status = "planned",
                phase = 4,
                features = new[] { "tag-taxonomy", "ai-spritesheet-pipeline", "mgcb-xnb-compile" },
                editor = new
                {
                    panel = "asset-taxonomy",
                    gizmos = Array.Empty<string>(),
                    nodeTypes = new[] { "tag", "sprite-sheet", "generation-job" },
                    properties = Array.Empty<object>(),
                },
            },
        },
    };
}
