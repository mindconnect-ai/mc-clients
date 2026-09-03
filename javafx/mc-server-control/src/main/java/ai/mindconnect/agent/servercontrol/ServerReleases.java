package ai.mindconnect.agent.servercontrol;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.function.Consumer;
import java.util.function.IntConsumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Which server builds exist, and how to get one onto disk. Two sources feed
 * the catalog: the releases on Maven Central, and the rolling snapshot
 * pre-releases on GitHub — one channel per branch, {@code main}'s being the
 * development build proper.
 *
 * <p>Preferred delivery either way is the Spring Boot executable jar
 * (classifier {@code exec}). Releases published before that jar existed have
 * none; for those the fallback resolves the runtime classpath with a local
 * Maven installation into {@code lib-<version>/}, the same trick the shell
 * scripts use.
 */
public final class ServerReleases {

    public static final String GROUP_PATH = "ai/mindconnect";
    public static final String APP = "mc-agent-admin-ui-app";
    public static final String MAIN_CLASS = "ai.mindconnect.adminui.AdminUiApplication";

    /**
     * The tag {@code main}'s snapshot is published under. Every other branch
     * gets {@code snapshot-<slug>}, the slug being the branch name with
     * {@code /} and upper case folded to {@code -}.
     */
    public static final String MAIN_SNAPSHOT_TAG = "snapshot";

    private static final String CENTRAL = "https://repo1.maven.org/maven2/" + GROUP_PATH + "/" + APP;
    private static final String GITHUB_REPO = "mindconnect-ai/mindconnect";

    /**
     * Where the snapshot channels are listed. The workflow publishes each
     * branch's channel on its own, so two branches can finish at the same
     * moment — an index file they both wrote would lose one of them; the
     * Releases API has no such race. Unauthenticated calls get 60 per hour,
     * ample for a launcher; when that runs out (403), or the API is otherwise
     * unreachable, the catalog falls back to {@code main}'s channel alone.
     */
    private static final String RELEASES_API =
            "https://api.github.com/repos/" + GITHUB_REPO + "/releases?per_page=100";

    /**
     * Base of every channel's assets: {@code <DOWNLOADS><tag>/…}. The assets
     * carry the development version in their name, so the file on disk says
     * which build it is — and the version to ask for stands in
     * {@code snapshot.txt}, one per channel.
     */
    private static final String DOWNLOADS = "https://github.com/" + GITHUB_REPO + "/releases/download/";

    private static final Duration TIMEOUT = Duration.ofSeconds(20);
    private static final Pattern VERSION_TAG = Pattern.compile("<version>([^<]+)</version>");
    private static final Pattern FIELD = Pattern.compile("(?m)^(\\w+):\\s*(.+)$");
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Where a build comes from. */
    public enum Source { CENTRAL, SNAPSHOT }

    /**
     * One installable server build.
     *
     * @param version     the Maven version — also the name of the local jar
     * @param source      which of the two channels it came from
     * @param downloadUrl the executable jar, or null when only Maven resolution reaches it
     * @param detail      what to show beside the state — commit and build time for a snapshot
     * @param branch      the branch a snapshot was built from; null for a Central release
     */
    public record ServerRelease(String version, Source source, String downloadUrl, String detail,
                                String branch) {}

    /** What one channel's {@code snapshot.txt} says. */
    private record Snapshot(String tag, String version, String commit, String branch, String built) {

        boolean isMain() {
            return MAIN_SNAPSHOT_TAG.equals(tag);
        }

        ServerRelease toRelease() {
            String detail = commit == null ? built
                    : built == null ? commit : commit + " · " + built;
            return new ServerRelease(version, Source.SNAPSHOT,
                    DOWNLOADS + tag + "/" + APP + "-" + version + "-exec.jar", detail, branch);
        }
    }

    private final ServerHome home;
    private final HttpClient http = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .connectTimeout(TIMEOUT)
            .build();

    public ServerReleases(ServerHome home) {
        this.home = home;
    }

    /**
     * Everything installable: {@code main}'s snapshot first, then the branch
     * snapshots newest build first, then the releases newest first. An
     * unreachable snapshot channel is left out rather than failing the
     * catalog — Central alone is still a usable list.
     */
    public List<ServerRelease> catalog() throws IOException, InterruptedException {
        List<Snapshot> snapshots = new ArrayList<>();
        for (String tag : snapshotChannels()) {
            readSnapshot(tag).ifPresent(snapshots::add);
        }
        snapshots.sort(Comparator.comparing((Snapshot s) -> !s.isMain())
                .thenComparing(s -> s.built() == null ? "" : s.built(), Comparator.reverseOrder()));

        List<ServerRelease> catalog = new ArrayList<>();
        for (Snapshot snapshot : snapshots) catalog.add(snapshot.toRelease());
        for (String version : centralVersions()) {
            catalog.add(new ServerRelease(version, Source.CENTRAL,
                    CENTRAL + "/" + version + "/" + APP + "-" + version + "-exec.jar", null, null));
        }
        return catalog;
    }

    /** All released versions on Central, newest first. */
    public List<String> centralVersions() throws IOException, InterruptedException {
        HttpResponse<String> response = http.send(
                HttpRequest.newBuilder(URI.create(CENTRAL + "/maven-metadata.xml")).build(),
                HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw new IOException("Maven Central answered " + response.statusCode());
        }
        List<String> versions = new ArrayList<>();
        Matcher m = VERSION_TAG.matcher(response.body());
        while (m.find()) versions.add(m.group(1));
        java.util.Collections.reverse(versions);
        return versions;
    }

    /**
     * The tags of all snapshot channels, in the order the API lists them:
     * every pre-release tagged {@code snapshot} or {@code snapshot-<slug>}.
     * When the API cannot be asked — offline, rate-limited, or answering
     * something that is not JSON — the answer is {@code main}'s channel
     * alone, which is what the launcher knew before branch channels existed.
     */
    public List<String> snapshotChannels() {
        try {
            HttpResponse<String> response = http.send(
                    HttpRequest.newBuilder(URI.create(RELEASES_API))
                            .header("Accept", "application/vnd.github+json")
                            .header("X-GitHub-Api-Version", "2022-11-28")
                            .timeout(TIMEOUT)
                            .build(),
                    HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) return List.of(MAIN_SNAPSHOT_TAG);

            List<String> tags = new ArrayList<>();
            for (JsonNode release : JSON.readTree(response.body())) {
                String tag = release.path("tag_name").asText("");
                boolean prerelease = release.path("prerelease").asBoolean(false);
                if (prerelease && (tag.equals(MAIN_SNAPSHOT_TAG)
                        || tag.startsWith(MAIN_SNAPSHOT_TAG + "-"))) {
                    tags.add(tag);
                }
            }
            return tags;
        } catch (IOException | RuntimeException unreachable) {
            return List.of(MAIN_SNAPSHOT_TAG);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return List.of(MAIN_SNAPSHOT_TAG);
        }
    }

    /**
     * The current development build of {@code main}, read off its channel's
     * {@code snapshot.txt}. Empty when the channel is unreachable or was
     * never filled — that is a normal state, not an error, so it is not
     * thrown.
     */
    public Optional<ServerRelease> snapshot() {
        return snapshot(MAIN_SNAPSHOT_TAG);
    }

    /**
     * The build one snapshot channel currently carries, read off its
     * {@code snapshot.txt} (version, commit, branch, build time). Empty when
     * the file is missing — a channel whose branch was deleted, or a run that
     * was interrupted before the upload — or the channel is unreachable.
     */
    public Optional<ServerRelease> snapshot(String tag) {
        return readSnapshot(tag).map(Snapshot::toRelease);
    }

    private Optional<Snapshot> readSnapshot(String tag) {
        try {
            HttpResponse<String> response = http.send(
                    HttpRequest.newBuilder(URI.create(DOWNLOADS + tag + "/snapshot.txt"))
                            .timeout(TIMEOUT)
                            .build(),
                    HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) return Optional.empty();

            String version = null;
            String commit = null;
            String branch = null;
            String built = null;
            Matcher m = FIELD.matcher(response.body());
            while (m.find()) {
                switch (m.group(1)) {
                    case "version" -> version = m.group(2).trim();
                    case "commit" -> commit = m.group(2).trim();
                    case "branch" -> branch = m.group(2).trim();
                    case "built" -> built = m.group(2).trim();
                    default -> { }
                }
            }
            if (version == null || version.isBlank()) return Optional.empty();
            return Optional.of(new Snapshot(tag, version, commit, branch, built));
        } catch (IOException offline) {
            return Optional.empty();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return Optional.empty();
        }
    }

    public Path execJar(String version) {
        return home.dir().resolve(APP + "-" + version + "-exec.jar");
    }

    public Path libDir(String version) {
        return home.dir().resolve("lib-" + version);
    }

    /** True when this version can be started without touching the network. */
    public boolean isInstalled(String version) {
        return Files.exists(execJar(version)) || Files.isDirectory(libDir(version));
    }

    /**
     * Downloads the executable jar of one build; reports progress in percent.
     * Returns false when there is none to be had — a Central release from
     * before the {@code exec} classifier existed; the caller then decides
     * about the Maven fallback.
     *
     * <p>An already-present file of the same name is overwritten on purpose: a
     * snapshot keeps its version while the build behind it moves on, so
     * "download" has to mean "fetch again". Branch snapshots carry the branch
     * in their version, so channels never overwrite each other.
     */
    public boolean downloadExecJar(ServerRelease release, IntConsumer percent)
            throws IOException, InterruptedException {
        if (release.downloadUrl() == null) return false;
        URI uri = URI.create(release.downloadUrl());
        HttpResponse<InputStream> response = http.send(
                HttpRequest.newBuilder(uri).build(), HttpResponse.BodyHandlers.ofInputStream());
        if (response.statusCode() == 404) return false;
        if (response.statusCode() != 200) {
            throw new IOException(uri + " answered " + response.statusCode());
        }
        long total = response.headers().firstValueAsLong("content-length").orElse(-1);
        Path target = execJar(release.version());
        Path part = target.resolveSibling(target.getFileName() + ".part");
        try (InputStream in = response.body(); OutputStream out = Files.newOutputStream(part)) {
            byte[] buffer = new byte[64 * 1024];
            long done = 0;
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
                done += read;
                if (total > 0) percent.accept((int) (done * 100 / total));
            }
        }
        Files.move(part, target, StandardCopyOption.REPLACE_EXISTING);
        percent.accept(100);
        return true;
    }

    /**
     * Fallback: resolve the runtime classpath with a local {@code mvn} into
     * {@code lib-<version>/}. Maven's own output is streamed to {@code output}
     * so the UI can show what is happening.
     */
    public void resolveWithMaven(String version, Consumer<String> output)
            throws IOException, InterruptedException {
        Path mvn = findMaven();
        if (mvn == null) {
            throw new IOException("No executable jar for this version and no local Maven found — "
                    + "install Maven (brew install maven / winget install Apache.Maven) and retry.");
        }
        Path pom = home.dir().resolve("resolve-pom.xml");
        Files.writeString(pom, """
                <project xmlns="http://maven.apache.org/POM/4.0.0">
                  <modelVersion>4.0.0</modelVersion>
                  <groupId>local</groupId><artifactId>resolve</artifactId><version>1</version>
                  <packaging>pom</packaging>
                  <dependencies>
                    <dependency>
                      <groupId>ai.mindconnect</groupId>
                      <artifactId>%s</artifactId>
                      <version>%s</version>
                    </dependency>
                  </dependencies>
                </project>
                """.formatted(APP, version));
        Files.createDirectories(libDir(version));
        Process process = new ProcessBuilder(mvn.toString(), "-B", "-f", pom.toString(),
                "dependency:copy-dependencies",
                "-DincludeScope=runtime",
                "-DoutputDirectory=" + libDir(version))
                .redirectErrorStream(true)
                .start();
        try (var reader = process.inputReader()) {
            reader.lines().forEach(output);
        }
        if (process.waitFor() != 0) {
            throw new IOException("Maven dependency resolution failed — see the log above.");
        }
    }

    private static Path findMaven() {
        String pathVar = System.getenv("PATH");
        if (pathVar == null) return null;
        boolean windows = System.getProperty("os.name", "").toLowerCase().contains("win");
        for (String entry : pathVar.split(java.io.File.pathSeparator)) {
            Path candidate = Path.of(entry).resolve(windows ? "mvn.cmd" : "mvn");
            if (Files.isExecutable(candidate)) return candidate;
        }
        return null;
    }
}
