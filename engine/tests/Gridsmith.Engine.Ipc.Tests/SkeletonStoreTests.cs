using System.Numerics;
using Gridsmith.Engine.Core.Rigging;
using Xunit;

namespace Gridsmith.Engine.Ipc.Tests;

public class SkeletonStoreTests
{
    [Fact]
    public void Register_and_find_roundtrip()
    {
        var store = new SkeletonStore(maxSkeletons: 2);
        var handle = store.Register("hero", [-1, 0], [Matrix3x2.Identity, Matrix3x2.Identity]);

        Assert.True(handle.IsValid);
        Assert.Equal(handle, store.Find("hero"));
        Assert.Equal(2, store.BoneCount(handle));
        Assert.False(store.Find("missing").IsValid);
    }

    [Fact]
    public void Register_rejects_non_topological_parent_order()
    {
        var store = new SkeletonStore(maxSkeletons: 1);
        // osso 0 aponta para pai 1, que ainda não existe na ordem
        Assert.Throws<ArgumentException>(() =>
            store.Register("bad", [1, -1], [Matrix3x2.Identity, Matrix3x2.Identity]));
    }

    [Fact]
    public void Full_store_rejects_registration_capacity_is_fixed()
    {
        var store = new SkeletonStore(maxSkeletons: 1);
        store.Register("only", [-1], [Matrix3x2.Identity]);
        Assert.Throws<InvalidOperationException>(() =>
            store.Register("overflow", [-1], [Matrix3x2.Identity]));
    }

    [Fact]
    public void ComputeWorldPoses_resolves_hierarchy_translations()
    {
        var store = new SkeletonStore(maxSkeletons: 1);
        var handle = store.Register("chain", [-1, 0, 1],
            [Matrix3x2.Identity, Matrix3x2.Identity, Matrix3x2.Identity]);

        var local = store.LocalPose(handle);
        local[0] = Matrix3x2.CreateTranslation(10, 0);
        local[1] = Matrix3x2.CreateTranslation(5, 0);
        local[2] = Matrix3x2.CreateTranslation(1, 2);

        store.ComputeWorldPoses(handle);
        var world = store.WorldPose(handle);

        Assert.Equal(new Vector2(10, 0), world[0].Translation);
        Assert.Equal(new Vector2(15, 0), world[1].Translation);
        Assert.Equal(new Vector2(16, 2), world[2].Translation);
    }

    [Fact]
    public void ComputeWorldPoses_applies_inverse_bind_to_skinning_matrices()
    {
        var store = new SkeletonStore(maxSkeletons: 1);
        // bind pose do osso em (10,0): inverseBind desloca o vértice para o espaço do osso
        var inverseBind = Matrix3x2.CreateTranslation(-10, 0);
        var handle = store.Register("skin", [-1], [inverseBind]);

        store.LocalPose(handle)[0] = Matrix3x2.CreateTranslation(12, 3);
        store.ComputeWorldPoses(handle);

        // vértice que estava exatamente sobre o osso na bind pose (10,0)
        // deve acompanhar o osso para (12,3)
        var skinned = Vector2.Transform(new Vector2(10, 0), store.SkinningMatrices(handle)[0]);
        Assert.Equal(new Vector2(12, 3), skinned);
    }

    [Fact]
    public void ComputeWorldPoses_is_allocation_free()
    {
        var store = new SkeletonStore(maxSkeletons: 1);
        var parents = new int[64];
        var bind = new Matrix3x2[64];
        parents[0] = -1;
        bind[0] = Matrix3x2.Identity;
        for (var i = 1; i < 64; i++)
        {
            parents[i] = i - 1;
            bind[i] = Matrix3x2.Identity;
        }

        var handle = store.Register("zero-gc", parents, bind);
        for (var w = 0; w < 1_000; w++) // aquecimento além do tiered JIT
        {
            store.ComputeWorldPoses(handle);
        }

        var allocated = AllocationProbe.MinimumAllocatedBytes(() =>
        {
            for (var frame = 0; frame < 1000; frame++)
            {
                store.ComputeWorldPoses(handle);
            }
        });

        Assert.Equal(0, allocated);
    }
}
