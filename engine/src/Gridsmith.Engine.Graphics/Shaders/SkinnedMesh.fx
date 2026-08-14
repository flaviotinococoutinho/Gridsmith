// Linear Blend Skinning 2D — vertex shader do plano de dados.
//
// CONTRATO ESPELHADO: a combinação ponderada implementada aqui é idêntica à
// referência de CPU Gridsmith.Engine.Core/Rigging/LinearBlendSkinning.cs, coberta
// por testes. As matrizes chegam de SkeletonStore.SkinningMatrices
// (worldPose × inverseBind), convertidas de Matrix3x2 para float4 pares
// (linha0.xy, linha1.xy | linha2.xy = translação).
//
// O layout de entrada segue SkinnedVertex2D (stride 36):
//   POSITION0  float2  — posição no espaço do modelo
//   TEXCOORD0  float2  — uv
//   BLENDINDICES0 ubyte4 — índices dos 4 ossos
//   BLENDWEIGHT0  float4 — pesos (soma ≈ 1.0)

#if OPENGL
    #define VS_SHADERMODEL vs_3_0
    #define PS_SHADERMODEL ps_3_0
#else
    #define VS_SHADERMODEL vs_4_0
    #define PS_SHADERMODEL ps_4_0
#endif

#define MAX_BONES 256

// Cada osso ocupa 2 registradores float4:
//   BoneRows[i*2 + 0] = (m11, m12, m21, m22)  — rotação/escala
//   BoneRows[i*2 + 1] = (m31, m32, 0, 0)      — translação
float4 BoneRows[MAX_BONES * 2];

float4x4 ViewProjection;

Texture2D AlbedoTexture;
sampler2D AlbedoSampler = sampler_state { Texture = <AlbedoTexture>; };

struct VertexInput
{
    float2 Position : POSITION0;
    float2 Uv : TEXCOORD0;
    float4 BoneIndices : BLENDINDICES0;
    float4 BoneWeights : BLENDWEIGHT0;
};

struct VertexOutput
{
    float4 Position : SV_Position;
    float2 Uv : TEXCOORD0;
};

float2 TransformBone(float2 position, int bone)
{
    float4 rot = BoneRows[bone * 2 + 0];
    float4 trans = BoneRows[bone * 2 + 1];
    // Convenção row-vector (System.Numerics.Matrix3x2):
    //   out = pos.x * (m11, m12) + pos.y * (m21, m22) + (m31, m32)
    return position.x * rot.xy + position.y * rot.zw + trans.xy;
}

VertexOutput SkinnedVS(VertexInput input)
{
    float2 skinned = float2(0, 0);
    float totalWeight = 0;

    [unroll]
    for (int slot = 0; slot < 4; slot++)
    {
        float weight = input.BoneWeights[slot];
        if (weight > 0)
        {
            int bone = (int)input.BoneIndices[slot];
            skinned += TransformBone(input.Position, bone) * weight;
            totalWeight += weight;
        }
    }

    // Mesma degradação robusta da referência de CPU: pesos ausentes → rígido.
    skinned = totalWeight > 1e-6 ? skinned / totalWeight : input.Position;

    VertexOutput output;
    output.Position = mul(float4(skinned, 0, 1), ViewProjection);
    output.Uv = input.Uv;
    return output;
}

float4 SkinnedPS(VertexOutput input) : COLOR0
{
    return tex2D(AlbedoSampler, input.Uv);
}

technique SkinnedMesh
{
    pass P0
    {
        VertexShader = compile VS_SHADERMODEL SkinnedVS();
        PixelShader = compile PS_SHADERMODEL SkinnedPS();
    }
}
