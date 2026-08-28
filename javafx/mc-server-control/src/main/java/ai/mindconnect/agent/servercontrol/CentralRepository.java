package ai.mindconnect.agent.servercontrol;

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
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.IntConsumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Everything the launcher needs from Maven Central: which versions of the
 * admin UI exist, and how to get a runnable one onto disk.
 *
 * <p>Preferred delivery is the Spring Boot executable jar (classifier
 * {@code exec}). Until that is published, the fallback resolves the runtime
 * classpath with a local Maven installation into {@code lib-<version>/} —
 * the same trick the shell scripts use.
 */
public final class CentralRepository {

    public static final String GROUP_PATH = "ai/mindconnect";
    public static final String APP = "mc-agent-admin-ui-app";
    public static final String MAIN_CLASS = "ai.mindconnect.adminui.AdminUiApplication";

    private static final String BASE = "https://repo1.maven.org/maven2/" + GROUP_PATH + "/" + APP;
    private static final Pattern VERSION_TAG = Pattern.compile("<version>([^<]+)</version>");

    private final ServerHome home;
    private final HttpClient http = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    public CentralRepository(ServerHome home) {
        this.home = home;
    }

    /** All released versions, newest first. */
    public List<String> versions() throws IOException, InterruptedException {
        HttpResponse<String> response = http.send(
                HttpRequest.newBuilder(URI.create(BASE + "/maven-metadata.xml")).build(),
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
     * Tries the executable jar; reports download progress in percent.
     * Returns false when Central has no {@code exec} classifier for this
     * version (the current state of the world) — the caller then decides
     * about the Maven fallback.
     */
    public boolean downloadExecJar(String version, IntConsumer percent)
            throws IOException, InterruptedException {
        URI uri = URI.create(BASE + "/" + version + "/" + APP + "-" + version + "-exec.jar");
        HttpResponse<InputStream> response = http.send(
                HttpRequest.newBuilder(uri).build(), HttpResponse.BodyHandlers.ofInputStream());
        if (response.statusCode() == 404) return false;
        if (response.statusCode() != 200) {
            throw new IOException("Maven Central answered " + response.statusCode() + " for " + uri);
        }
        long total = response.headers().firstValueAsLong("content-length").orElse(-1);
        Path part = execJar(version).resolveSibling(execJar(version).getFileName() + ".part");
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
        Files.move(part, execJar(version), StandardCopyOption.REPLACE_EXISTING);
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
            throw new IOException("No executable jar on Central and no local Maven found — "
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
