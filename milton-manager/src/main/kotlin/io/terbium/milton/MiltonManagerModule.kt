package io.terbium.milton

import com.google.inject.AbstractModule
import com.typesafe.config.ConfigFactory
import javax.inject.Qualifier


class MiltonManagerModule : AbstractModule() {
    override fun configure() {
        val conf = ConfigFactory.load()
        val secretConf = ConfigFactory.load("secrets")
        bind(String::class.java)
                .annotatedWith(GoogleAuthClientId::class.java)
                .toInstance(secretConf.getString("secrets.googleAuthClientId")!!)
        bind(String::class.java)
                .annotatedWith(AlgoliaAccount::class.java)
                .toInstance(secretConf.getString("secrets.algoliaAccount")!!)
        bind(String::class.java)
                .annotatedWith(AlgoliaSecret::class.java)
                .toInstance(secretConf.getString("secrets.algoliaSecret")!!)
        bind(String::class.java)
                .annotatedWith(ProcessorHost::class.java)
                .toInstance(conf.getString("milton.processorHost")!!)
        bind(String::class.java)
                .annotatedWith(ProjectName::class.java)
                .toInstance(conf.getString("milton.projectName"))
    }
}

@Qualifier
@Target(AnnotationTarget.FIELD, AnnotationTarget.VALUE_PARAMETER, AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
annotation class GoogleAuthClientId

@Qualifier
@Target(AnnotationTarget.FIELD, AnnotationTarget.VALUE_PARAMETER, AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
annotation class AlgoliaAccount

@Qualifier
@Target(AnnotationTarget.FIELD, AnnotationTarget.VALUE_PARAMETER, AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
annotation class AlgoliaSecret

@Qualifier
@Target(AnnotationTarget.FIELD, AnnotationTarget.VALUE_PARAMETER, AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
annotation class ProcessorHost

@Qualifier
@Target(AnnotationTarget.FIELD, AnnotationTarget.VALUE_PARAMETER, AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
annotation class ProjectName
