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
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.function.Consumer;
import java.util.function.IntConsumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Which server builds exist, and how to get one onto disk. Three sources
 * feed the catalog: the releases on Maven Central; the rolling snapshot
 * pre-releases on GitHub — one channel per branch, {@code main}'s being the
 * development build proper; and the local Maven repository, where
 * {@code mvn install} in a server checkout leaves its builds.
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

    /**
     * The local Maven repository — what was built or fetched on this machine.
     * {@code maven.repo.local} is the property Maven itself honours.
     */
    private static final Path LOCAL_REPO = Path.of(System.getProperty("maven.repo.local",
            Path.of(System.getProperty("user.home"), ".m2", "repository").toString()));

    /**
     * Where the server jar carries its changelog — the repository's
     * CHANGELOG.md, packaged as a resource since mindconnect
     * feature/changelog-in-jar. Spring Boot's repackaging keeps META-INF at
     * the root, so the plain jar and the exec jar hold it at the same path.
     */
    private static final List<String> JAR_CHANGELOG = List.of("META-INF/CHANGELOG.md");

    private static final DateTimeFormatter MINUTE_UTC =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm'Z'").withZone(ZoneOffset.UTC);
    private static final Duration TIMEOUT = Duration.ofSeconds(20);
    private static final Pattern VERSION_TAG = Pattern.compile("<version>([^<]+)</version>");
    private static final Pattern FIELD = Pattern.compile("(?m)^(\\w+):\\s*(.+)$");
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Where a build comes from. */
    public enum Source { CENTRAL, SNAPSHOT, LOCAL }

    /**
     * One installable server build.
     *
     * @param version     the Maven version — also the name of the local jar
     * @param source      which of the three sources it came from
     * @param downloadUrl the executable jar — https for the remote sources, a
     *                    {@code file:} URI for the local repository — or null
     *                    when only Maven resolution reaches it
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
            String when = shortUtc(built);
            String detail = commit == null ? when
                    : when == null ? commit : commit + " · " + when;
            return new ServerRelease(version, Source.SNAPSHOT,
                    DOWNLOADS + tag + "/" + APP + "-" + version + "-exec.jar", detail, branch);
        }
    }

    /**
     * {@code 2026-09-03T15:12Z} → {@code 09-03 15:12}: the year is noise in a
     * list of rolling builds, and the table has to fit beside the version.
     * Anything not in that shape is passed through.
     */
    static String shortUtc(String isoMinute) {
        if (isoMinute == null) return null;
        return isoMinute.matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}Z?")
                ? isoMinute.substring(5, 16).replace('T', ' ')
                : isoMinute;
    }

    /** Release-note bodies by tag, as the Releases API handed them over — the fallback changelog. */
    private final Map<String, String> releaseNotes = new ConcurrentHashMap<>();

    private final ServerHome home;
    private final HttpClient http = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .connectTimeout(TIMEOUT)
            .build();

    public ServerReleases(ServerHome home) {
        this.home = home;
    }

    /**
     * Everything installable, snapshots first, then the Central releases, then
     * the local builds — each group in its own order, see {@link #snapshots()},
     * {@link #central()} and {@link #local()}.
     */
    public List<ServerRelease> catalog() throws IOException, InterruptedException {
        List<ServerRelease> catalog = new ArrayList<>(snapshots());
        catalog.addAll(central());
        catalog.addAll(local());
        return catalog;
    }

    /** The releases on Maven Central, newest first. */
    public List<ServerRelease> central() throws IOException, InterruptedException {
        List<ServerRelease> releases = new ArrayList<>();
        for (String version : centralVersions()) {
            releases.add(new ServerRelease(version, Source.CENTRAL,
                    CENTRAL + "/" + version + "/" + APP + "-" + version + "-exec.jar", null, null));
        }
        return releases;
    }

    /**
     * The snapshot channels: {@code main}'s first, then the branches newest
     * build first. An unreachable channel is left out rather than thrown —
     * the list is still usable without it.
     */
    public List<ServerRelease> snapshots() {
        List<Snapshot> snapshots = new ArrayList<>();
        for (String tag : snapshotChannels()) {
            readSnapshot(tag).ifPresent(snapshots::add);
        }
        snapshots.sort(Comparator.comparing((Snapshot s) -> !s.isMain())
                .thenComparing(s -> s.built() == null ? "" : s.built(), Comparator.reverseOrder()));
        List<ServerRelease> releases = new ArrayList<>();
        for (Snapshot snapshot : snapshots) releases.add(snapshot.toRelease());
        return releases;
    }

    /** A build in the local Maven repository. */
    private record LocalBuild(String version, Path jar, boolean exec, Instant built) {

        ServerRelease toRelease() {
            String detail = (exec ? "exec jar" : "classpath via Maven") + " · "
                    + shortUtc(MINUTE_UTC.format(built));
            return new ServerRelease(version, Source.LOCAL,
                    exec ? jar.toUri().toString() : null, detail, null);
        }
    }

    /**
     * The server builds in the local Maven repository, newest first — every
     * version directory holding a jar of the app. The executable jar is
     * installed by copying it; a version with only the plain jar is
     * resolved with Maven, which works offline when the dependencies are
     * there too. A directory with nothing but a pom was never built here and
     * is skipped.
     */
    public List<ServerRelease> local() throws IOException {
        Path dir = LOCAL_REPO.resolve(GROUP_PATH).resolve(APP);
        if (!Files.isDirectory(dir)) return List.of();
        List<LocalBuild> builds = new ArrayList<>();
        try (var versions = Files.list(dir)) {
            for (Path versionDir : (Iterable<Path>) versions::iterator) {
                if (!Files.isDirectory(versionDir)) continue;
                String version = versionDir.getFileName().toString();
                Path exec = versionDir.resolve(APP + "-" + version + "-exec.jar");
                Path plain = versionDir.resolve(APP + "-" + version + ".jar");
                Path jar = Files.exists(exec) ? exec : Files.exists(plain) ? plain : null;
                if (jar == null) continue;
                builds.add(new LocalBuild(version, jar, jar == exec,
                        Files.getLastModifiedTime(jar).toInstant()));
            }
        }
        builds.sort(Comparator.comparing(LocalBuild::built).reversed());
        List<ServerRelease> releases = new ArrayList<>();
        for (LocalBuild build : builds) releases.add(build.toRelease());
        return releases;
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
                String body = release.path("body").asText("");
                if (!tag.isBlank() && !body.isBlank()) releaseNotes.put(tag, body);
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

    /**
     * What this build changes, for a click on its row. First choice is the
     * changelog inside the jar — exact for the build, readable offline, and
     * for a branch build the {@code [Unreleased]} section is the description
     * of the very fix one installs it to try. Only a jar on disk can be read:
     * the installed one, or a local-repository one before it is installed.
     * Without a jar, or with a jar from before the changelog was packaged,
     * the release note GitHub attached to the tag stands in — the Releases
     * API delivered those together with the channel list. Empty when
     * neither exists.
     */
    public Optional<String> changelog(ServerRelease release) {
        for (Path jar : jarsOnDisk(release)) {
            String text = readEntry(jar, JAR_CHANGELOG);
            if (text != null) return Optional.of(section(text, release.version()));
        }
        String tag = tagFor(release);
        return Optional.ofNullable(tag == null ? null : releaseNotes.get(tag));
    }

    private List<Path> jarsOnDisk(ServerRelease release) {
        List<Path> jars = new ArrayList<>();
        if (Files.exists(execJar(release.version()))) jars.add(execJar(release.version()));
        if (release.downloadUrl() != null && release.downloadUrl().startsWith("file:")) {
            jars.add(Path.of(URI.create(release.downloadUrl())));
        }
        return jars;
    }

    private static String readEntry(Path jar, List<String> names) {
        try (ZipFile zip = new ZipFile(jar.toFile())) {
            for (String name : names) {
                ZipEntry entry = zip.getEntry(name);
                if (entry != null) {
                    try (InputStream in = zip.getInputStream(entry)) {
                        return new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
                    }
                }
            }
        } catch (IOException unreadable) {
            // a half-written or foreign jar — the fallback below still applies
        }
        return null;
    }

    /** The GitHub tag whose release note describes this build, or null for a local build. */
    private static String tagFor(ServerRelease release) {
        return switch (release.source()) {
            case CENTRAL -> "v" + release.version();
            case SNAPSHOT -> {
                String url = release.downloadUrl();
                if (url == null || !url.startsWith(DOWNLOADS)) yield null;
                String rest = url.substring(DOWNLOADS.length());
                yield rest.substring(0, rest.indexOf('/'));
            }
            case LOCAL -> null;
        };
    }

    /**
     * The one section of a Keep-a-Changelog file that belongs to this build:
     * {@code ## [<version>]} for a release, {@code ## [Unreleased]} for a
     * snapshot — what the branch has changed and not released yet. When the
     * section is missing or empty that is said in a line rather than showing
     * a different version's news.
     */
    static String section(String changelog, String version) {
        String heading = version.endsWith("-SNAPSHOT") ? "## [Unreleased]" : "## [" + version + "]";
        String out = between(changelog, heading);
        // The release workflow renames [Unreleased] to the version before it
        // builds the jar, so a release normally finds its own heading. A
        // release built by hand has not been renamed - then [Unreleased] is
        // the section that was about to become it.
        if (out.isEmpty() && !version.endsWith("-SNAPSHOT")) {
            heading = "## [Unreleased]";
            out = between(changelog, heading);
        }
        if (out.isEmpty()) return heading + "\n\nNo such section in the changelog this build carries.";
        if (out.lines().skip(1).allMatch(String::isBlank)) {
            return out.strip() + "\n\nNo entries — nothing is written up for this build yet.";
        }
        return out.strip();
    }

    /** The heading line and everything up to the next version heading; empty when absent. */
    private static String between(String changelog, String heading) {
        StringBuilder out = new StringBuilder();
        boolean inside = false;
        for (String line : changelog.split("\\R")) {
            if (line.startsWith(heading)) {
                inside = true;
                out.append(line).append('\n');
            } else if (inside && line.startsWith("## [")) {
                break;
            } else if (inside) {
                out.append(line).append('\n');
            }
        }
        return out.toString();
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
        if ("file".equals(uri.getScheme())) {
            // The local repository: a copy, not a download.
            Files.copy(Path.of(uri), execJar(release.version()), StandardCopyOption.REPLACE_EXISTING);
            percent.accept(100);
            return true;
        }
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
