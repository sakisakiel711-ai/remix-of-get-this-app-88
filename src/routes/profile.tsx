import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AuthGate, PageHeader, gradientFor } from "@/components/PageScaffold";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { getMyArtist, slugify, uploadToBucket } from "@/lib/artist-helpers";
import { Dropzone } from "@/components/Dropzone";
import { Camera, Check, Loader2, Sparkles, ExternalLink, Shield, Lock, CreditCard, Wallet } from "lucide-react";
import { avatarOrDefault } from "@/lib/default-avatar";
import { coverOrDefault } from "@/lib/default-cover";
import { useIsAdmin } from "@/hooks/use-is-admin";
import {
  getArtistFeeStatus,
  createArtistFeePayment,
  payArtistFeeWithWallet,
  ARTIST_FEE_XOF,
} from "@/lib/artist-fee.functions";

export const Route = createFileRoute("/profile")({
  head: () => ({
    meta: [
      { title: "Profile Pro — VinaSound" },
      { name: "description", content: "Edit your artist profile, bio, avatar and cover image." },
    ],
  }),
  component: () => (
    <AuthGate>
      <ProfilePage />
    </AuthGate>
  ),
});

function ProfilePage() {
  const { user } = useAuth();
  const { isAdmin } = useIsAdmin();
  const qc = useQueryClient();

  const { data: artist, isLoading } = useQuery({
    queryKey: ["my-artist", user?.id],
    enabled: !!user?.id,
    queryFn: () => getMyArtist(user!.id),
  });

  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    if (artist) {
      setName(artist.name ?? "");
      setBio(artist.bio ?? "");
      setAvatarPreview(avatarOrDefault(artist.avatar_url, user?.id ?? null));
      setCoverPreview(coverOrDefault(artist.cover_url));
    } else {
      setAvatarPreview(avatarOrDefault(null, user?.id ?? null));
      setCoverPreview(coverOrDefault(null));
    }
  }, [artist, user?.id]);

  useEffect(() => {
    if (!avatarFile) return;
    const url = URL.createObjectURL(avatarFile);
    setAvatarPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [avatarFile]);

  useEffect(() => {
    if (!coverFile) return;
    const url = URL.createObjectURL(coverFile);
    setCoverPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [coverFile]);

  async function persistImage(kind: "avatar" | "cover", file: File) {
    if (!user) return;
    setErr(null);
    setSaving(true);
    try {
      const url = await uploadToBucket("covers", user.id, file, kind === "avatar" ? "avatar-" : "cover-");
      if (kind === "avatar") {
        await supabase.from("profiles").upsert({ id: user.id, avatar_url: url }, { onConflict: "id" });
        await supabase.auth.updateUser({ data: { avatar_url: url } });
      }
      if (artist) {
        const patch = kind === "avatar" ? { avatar_url: url } : { cover_url: url };
        const { error } = await supabase.from("artists").update(patch).eq("id", artist.id);
        if (error) throw error;
        qc.invalidateQueries({ queryKey: ["my-artist", user.id] });
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 2000);
        if (kind === "avatar") setAvatarFile(null);
        else setCoverFile(null);
      }
      // If no artist row yet, keep the local file; Save will create the record with these URLs.
      if (!artist) {
        if (kind === "avatar") (file as any)._uploadedUrl = url;
        else (file as any)._uploadedUrl = url;
      }
    } catch (e: any) {
      setErr(e.message ?? "Upload failed");
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    if (!user) return;
    setErr(null);
    setSaving(true);
    try {
      let avatar_url = artist?.avatar_url ?? null;
      let cover_url = artist?.cover_url ?? null;
      if (avatarFile) avatar_url = (avatarFile as any)._uploadedUrl ?? await uploadToBucket("covers", user.id, avatarFile, "avatar-");
      if (coverFile) cover_url = (coverFile as any)._uploadedUrl ?? await uploadToBucket("covers", user.id, coverFile, "cover-");

      if (avatarFile && avatar_url) {
        await supabase.from("profiles").upsert({ id: user.id, avatar_url }, { onConflict: "id" });
        await supabase.auth.updateUser({ data: { avatar_url } });
      }

      if (artist) {
        const { error } = await supabase
          .from("artists")
          .update({ name: name.trim(), bio: bio.trim() || null, avatar_url, cover_url })
          .eq("id", artist.id);
        if (error) throw error;
      } else {
        const baseSlug = slugify(name);
        const slug = `${baseSlug}-${Date.now().toString(36)}`;
        const { error } = await supabase.from("artists").insert({
          user_id: user.id,
          name: name.trim(),
          slug,
          bio: bio.trim() || null,
          avatar_url,
          cover_url,
        });
        if (error) throw error;
      }

      setAvatarFile(null);
      setCoverFile(null);
      qc.invalidateQueries({ queryKey: ["my-artist", user.id] });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (e: any) {
      setErr(e.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading profile…</p>;
  }

  const grad = gradientFor(name || "vinasound");
  const profileAvatar = avatarOrDefault(avatarPreview, user?.id ?? null);

  return (
    <>
      <PageHeader
        eyebrow="Studio"
        accent="Profil"
        title="Pro"
        description="Your public artist identity. Cover image, avatar and bio appear on your artist page."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {isAdmin && (
              <Link
                to="/admin"
                className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-primary to-primary/70 px-4 py-2 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 hover:opacity-90 transition"
              >
                <Shield className="w-4 h-4" /> Panneau Admin
              </Link>
            )}
            {artist && (
              <Link
                to="/artists/$slug"
                params={{ slug: artist.slug }}
                className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
              >
                View public page <ExternalLink className="w-4 h-4" />
              </Link>
            )}
          </div>
        }
      />

      {/* Cover preview */}
      <div className="rounded-xl overflow-hidden border border-border mb-6">
        <Dropzone accept="image/*" onFiles={(f) => { setCoverFile(f[0]); persistImage("cover", f[0]); }} className="rounded-none border-0">
          <div className="relative h-44 sm:h-56 w-full">
            {coverPreview ? (
              <img src={coverPreview} className="w-full h-full object-cover pointer-events-none" alt="" />
            ) : (
              <div className={`w-full h-full bg-gradient-to-br ${grad} pointer-events-none`} />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent pointer-events-none" />
            <div className="absolute bottom-3 right-3 inline-flex items-center gap-2 bg-background/90 rounded-full px-3 py-1.5 text-xs font-bold pointer-events-none">
              <Camera className="w-4 h-4" /> {coverFile ? "Cover prête — clique Save" : "Cliquer pour changer la cover"}
            </div>
          </div>
        </Dropzone>
      </div>

      <div className="grid lg:grid-cols-[200px_1fr] gap-6 lg:gap-10 max-w-4xl">
        {/* Avatar */}
        <Dropzone accept="image/*" onFiles={(f) => { setAvatarFile(f[0]); persistImage("avatar", f[0]); }} className="lg:rounded-full">
          <div className="relative aspect-square w-44 lg:w-full mx-auto rounded-full overflow-hidden">
            <img
              key={profileAvatar}
              src={profileAvatar}
              onError={(e) => {
                const img = e.currentTarget;
                const fallback = avatarOrDefault(null, user?.id ?? null);
                if (!img.src.endsWith(fallback)) img.src = fallback;
              }}
              className="w-full h-full object-cover pointer-events-none"
              alt="Avatar"
            />
            <div className="absolute inset-0 grid place-items-center bg-black/30 pointer-events-none">
              <span className="inline-flex items-center gap-2 bg-background/90 rounded-full px-3 py-1.5 text-xs font-bold">
                <Camera className="w-4 h-4" /> {avatarFile ? "Prêt" : "Changer"}
              </span>
            </div>
          </div>
        </Dropzone>

        {/* Form */}
        <div className="space-y-5">
          <div>
            <label className="block text-xs uppercase tracking-widest font-bold text-muted-foreground mb-2">Artist name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="Your stage name"
              className="w-full bg-surface border border-border rounded-md px-4 py-2.5 text-sm outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-widest font-bold text-muted-foreground mb-2">Bio</label>
            <textarea
              rows={6}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              maxLength={1000}
              placeholder="Tell fans about your sound, influences, and journey…"
              className="w-full bg-surface border border-border rounded-md px-4 py-3 text-sm outline-none focus:border-primary"
            />
            <p className="text-[11px] text-muted-foreground mt-1">{bio.length}/1000</p>
          </div>

          {err && <p className="text-sm text-destructive">{err}</p>}

          <div className="flex items-center gap-3">
            <button
              onClick={save}
              disabled={saving || !name.trim()}
              className="inline-flex items-center gap-2 bg-primary text-primary-foreground rounded-full px-6 py-2.5 text-sm font-bold disabled:opacity-60 hover:opacity-90"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              <span>{artist ? "Save changes" : "Create profile"}</span>
            </button>
            {savedFlash && (
              <span className="inline-flex items-center gap-1 text-emerald-400 text-sm font-semibold animate-fade-in">
                <Sparkles className="w-4 h-4" /> <span>Saved</span>
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
