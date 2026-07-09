// Passo 2 do pipeline deferred 2D: acumulação de luzes (Light Pass).
//
// CONTRATO ESPELHADO: as equações de atenuação, N·L e cone são idênticas à
// referência de CPU P7m.Engine.Core/Lighting/Lighting2D.cs, coberta por
// testes. Alterou lá, altere aqui.
//
// Renderizado uma vez por luz (quad do volume da luz) com blend aditivo
// sobre o alvo de acumulação. LightType: 0=direcional, 1=pontual, 2=spot.

#if OPENGL
    #define VS_SHADERMODEL vs_3_0
    #define PS_SHADERMODEL ps_3_0
#else
    #define VS_SHADERMODEL vs_4_0
    #define PS_SHADERMODEL ps_4_0
#endif

float4x4 ViewProjection;
float2 ScreenToWorldScale;
float2 ScreenToWorldOffset;

Texture2D NormalBuffer; // RT1 do G-Buffer
sampler2D NormalSampler = sampler_state { Texture = <NormalBuffer>; };

int LightType;
float2 LightPosition;
float LightHeight;
float2 LightDirection;   // normalizada; "para onde a luz aponta"
float3 LightColor;
float LightIntensity;
float LightRadius;
float InnerConeCos;
float OuterConeCos;

struct VertexInput
{
    float2 Position : POSITION0;
    float2 Uv : TEXCOORD0;
};

struct VertexOutput
{
    float4 Position : SV_Position;
    float2 Uv : TEXCOORD0;
    float2 World : TEXCOORD1;
};

// (1 - (d/r)^2)^2 clampado — mesma curva de Lighting2D.Attenuation
float Attenuation(float distance, float radius)
{
    float x = distance / radius;
    float factor = saturate(1.0 - x * x);
    return factor * factor;
}

VertexOutput LightVS(VertexInput input)
{
    VertexOutput output;
    output.Position = mul(float4(input.Position, 0, 1), ViewProjection);
    output.Uv = input.Uv;
    output.World = input.Position;
    return output;
}

float4 LightPS(VertexOutput input) : COLOR0
{
    // decodifica a normal do G-Buffer: [0,1] → [-1,1]
    float4 encoded = tex2D(NormalSampler, input.Uv);
    float3 normal = normalize(encoded.xyz * 2.0 - 1.0);

    float3 contribution = float3(0, 0, 0);

    if (LightType == 0) // direcional — Lighting2D.EvaluateDirectional
    {
        float3 l = normalize(float3(-LightDirection.x, -LightDirection.y, 0.5));
        float ndotl = saturate(dot(normal, l));
        contribution = LightColor * (LightIntensity * ndotl);
    }
    else // pontual/spot — Lighting2D.EvaluatePoint / EvaluateSpot
    {
        float3 delta = float3(LightPosition - input.World, LightHeight);
        float distance = length(delta);
        float3 l = distance > 1e-6 ? delta / distance : float3(0, 0, 1);
        float ndotl = saturate(dot(normal, l));
        contribution = LightColor * (LightIntensity * Attenuation(distance, LightRadius) * ndotl);

        if (LightType == 2) // fator de cone quadrático suave
        {
            float2 toSurface = normalize(input.World - LightPosition);
            float cosAngle = dot(toSurface, LightDirection);
            float denom = max(1e-6, InnerConeCos - OuterConeCos);
            float cone = saturate((cosAngle - OuterConeCos) / denom);
            contribution *= cone * cone;
        }
    }

    // alfa do normal buffer mascara pixels sem geometria
    return float4(contribution * encoded.a, 1.0);
}

technique DeferredLight
{
    pass P0
    {
        VertexShader = compile VS_SHADERMODEL LightVS();
        PixelShader = compile PS_SHADERMODEL LightPS();
    }
}
